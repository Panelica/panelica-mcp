#!/usr/bin/env node
// Build MCP tools.json from the Panelica External API spec.
//
// ZERO-DRIFT: the source of truth is the LIVE `/v1/api-spec` endpoint, which the
// backend generates at runtime from its route registry. This script never falls
// out of date by hand — point it at a running panel (or refresh the committed
// snapshot in CI) and the tool catalogue regenerates to match the API exactly.
//
// Source (in priority order):
//   1. $PANELICA_SPEC_URL  — fetch the live spec, then also refresh the snapshot.
//   2. ./api-spec.json      — committed snapshot (offline builds: npm/Smithery/CI).
//
// Output: ./tools.json  (one MCP tool per external endpoint)
//
// The spec is external-only + HMAC by construction (backend excludes internal
// routes), so no api_surface/auth filtering is needed here.
//
// MCP tool name format: panelica_<category-slug>_<method>_<path-slug> (<=64 chars).

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const snapshotPath = resolve(__dirname, "api-spec.json");
const outputPath = resolve(__dirname, "tools.json");

// ── Load the spec ────────────────────────────────────────────────────────────
async function loadSpec() {
    const url = process.env.PANELICA_SPEC_URL;
    if (url) {
        console.log(`Fetching live spec: ${url}`);
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`spec fetch failed: HTTP ${res.status}`);
        const json = await res.json();
        const data = deepRedact(json.data ?? json);
        data.base_url = "https://<your-panel>:8443/api/external/v1"; // never leak the source host
        writeFileSync(snapshotPath, JSON.stringify(data, null, 2) + "\n");
        console.log(`Refreshed snapshot: ${snapshotPath}`);
        return data;
    }
    console.log(`Reading snapshot: ${snapshotPath}`);
    return JSON.parse(readFileSync(snapshotPath, "utf8"));
}

// ── Redaction (defensive; the spec is already clean metadata) ─────────────────
const REDACTORS = [
    { re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, sub: "<uuid>" },
    { re: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)(?:\.\d{1,3}){2}\b/g, sub: "<ip>" },
    { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, sub: "<email>" },
    { re: /\/opt\/panelica[\w/.-]*/g, sub: "<path>" },
];
function redactStr(s) {
    let out = String(s ?? "");
    for (const r of REDACTORS) out = out.replace(r.re, r.sub);
    return out;
}
// Deep-redact the whole spec before it is written to the committed snapshot, so
// example UUIDs / private IPs from the live panel never land in the public repo.
function deepRedact(v) {
    if (typeof v === "string") return redactStr(v);
    if (Array.isArray(v)) return v.map(deepRedact);
    if (v && typeof v === "object") {
        const o = {};
        for (const [k, val] of Object.entries(v)) o[k] = deepRedact(val);
        return o;
    }
    return v;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// The live spec renders path params as {name}; the MCP client substitutes :name.
function toColonPath(p) {
    return String(p ?? "").replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, ":$1");
}
function slugify(s) {
    return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function toolName(method, path, category) {
    const cat = slugify(category || "misc");
    const m = String(method || "get").toLowerCase();
    let name = `panelica_${cat}_${m}_${slugify(path)}`;
    if (name.length > 64) {
        const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
        name = `${name.slice(0, 55)}_${hash}`;
    }
    return name;
}
function jsonType(t) {
    return t === "uuid" ? "string" : (t || "string");
}

function buildInputSchema(ep) {
    const properties = {};
    const required = [];
    const req = ep.request || {};

    for (const p of req.path_params ?? []) {
        properties[p.name] = { type: jsonType(p.type), description: redactStr(p.description || `Path parameter: ${p.name}`) };
        if (p.required !== false) required.push(p.name);
    }
    for (const q of req.query_params ?? []) {
        properties[q.name] = { type: jsonType(q.type), description: redactStr(q.description || `Query parameter: ${q.name}`) };
        if (q.required) required.push(q.name);
    }

    const body = req.body || {};
    if (body.fields?.length) {
        properties.body = {
            type: "object",
            description: `Request body (${body.content_type || "application/json"})`,
            properties: Object.fromEntries(body.fields.map(f => [f.name, {
                type: jsonType(f.type),
                description: redactStr(f.description || ""),
            }])),
            required: body.fields.filter(f => f.required).map(f => f.name),
        };
        if (body.required) required.push("body");
    } else if (["POST", "PUT", "PATCH"].includes(ep.method)) {
        properties.body = {
            type: "object",
            description: `Request body (${body.content_type || "application/json"}). Schema not statically declared — see API docs.`,
            additionalProperties: true,
        };
    }

    return { type: "object", properties, required: [...new Set(required)], additionalProperties: false };
}

// MCP tool annotations — best-in-class clients (Claude, etc.) use these to warn
// before mutating/destructive calls and to allow read-only auto-approval.
function annotations(ep) {
    const m = String(ep.method || "GET").toUpperCase();
    const readOnly = m === "GET" || m === "HEAD";
    const destructive = m === "DELETE";
    return {
        title: ep.summary || `${m} ${ep.path}`,
        readOnlyHint: readOnly,
        destructiveHint: destructive,
        idempotentHint: readOnly || m === "PUT" || m === "DELETE",
        openWorldHint: true, // reaches an external panel over the network
    };
}

function buildDescription(ep) {
    const colon = toColonPath(ep.path);
    const scopes = ep.auth?.scopes?.length ? `Required scopes: ${ep.auth.scopes.join(", ")}` : "";
    const risk = ep.method === "DELETE"
        ? "WARNING: destructive — permanently removes the resource."
        : (["POST", "PUT", "PATCH"].includes(ep.method) ? "Mutating: changes server state." : "Read-only.");
    return [
        redactStr(ep.description || ep.summary || `${ep.method} ${colon}`),
        `\nHTTP: ${ep.method} ${colon}`,
        `Category: ${ep.category}`,
        scopes,
        risk,
    ].filter(Boolean).join("\n");
}

// ── Build ────────────────────────────────────────────────────────────────────
const spec = await loadSpec();
const endpoints = spec.endpoints ?? [];
const stats = { total: endpoints.length, emitted: 0, skipped: 0, read: 0, mutate: 0, destructive: 0 };
const seen = new Set();
const tools = [];

for (const ep of endpoints) {
    if (!ep.method || !ep.path) { stats.skipped++; continue; }
    // Skip meta/unauthenticated endpoints that aren't real tools.
    if (/^\/(health|v1\/api-spec|v1\/postman-collection|v1\/metrics\/ws)$/.test(ep.path)) { stats.skipped++; continue; }

    let name = toolName(ep.method, ep.path, ep.category);
    while (seen.has(name)) name = `${name.slice(0, 55)}_${createHash("sha1").update(name + tools.length).digest("hex").slice(0, 8)}`;
    seen.add(name);

    const m = String(ep.method).toUpperCase();
    if (m === "GET" || m === "HEAD") stats.read++;
    else if (m === "DELETE") stats.destructive++;
    else stats.mutate++;

    tools.push({
        name,
        description: buildDescription(ep),
        inputSchema: buildInputSchema(ep),
        annotations: annotations(ep),
        metadata: {
            method: m,
            path: toColonPath(ep.path),
            category: ep.category,
            scopes: ep.auth?.scopes ?? [],
        },
    });
    stats.emitted++;
}

tools.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(outputPath, JSON.stringify(tools, null, 2) + "\n");

console.log(`Endpoints:   ${stats.total}`);
console.log(`Emitted:     ${stats.emitted}  (read ${stats.read}, mutate ${stats.mutate}, destructive ${stats.destructive})`);
console.log(`Skipped:     ${stats.skipped}`);
console.log(`Output:      ${outputPath}`);
