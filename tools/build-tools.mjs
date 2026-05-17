#!/usr/bin/env node
// Build MCP tools.json from the public Panelica External API dataset.
//
// Input:  ../api-dataset/panelica-api-complete.jsonl (1263 records)
// Output: ./tools.json (198 records, external only, redacted)
//
// Filters:
//   - api_surface == "external"  (excludes panel-internal endpoints)
//   - auth.type   == "hmac"      (defensive — every external is hmac in this dataset)
//
// Redaction passes (regex on stringified record):
//   - UUIDs                  -> <uuid>
//   - Private IPs (RFC1918)  -> <ip>
//   - Email addresses        -> <email>
//   - Internal file paths    -> stripped
//   - Stack traces           -> stripped
//   - Hostnames in URLs      -> <host>
//
// MCP tool name format: panelica_<category-slug>_<method>_<path-slug>
// Tool name limit per MCP spec: 64 chars (we truncate + hash if longer).

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const datasetPath = process.env.PANELICA_DATASET
    ?? resolve(__dirname, "../../api-dataset/panelica-api-complete.jsonl");
const outputPath = resolve(__dirname, "tools.json");

const raw = readFileSync(datasetPath, "utf8");
const lines = raw.trim().split("\n");

const REDACTORS = [
    { name: "uuid", re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, sub: "<uuid>" },
    { name: "rfc1918", re: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)(?:\.\d{1,3}){2}\b/g, sub: "<ip>" },
    { name: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, sub: "<email>" },
    { name: "abs-go-path", re: /\/(?:opt|home|var)\/[\w/.-]+\.go(?::\d+)?/g, sub: "<path>" },
    { name: "abs-panelica", re: /\/opt\/panelica[\w/.-]*/g, sub: "<path>" },
    { name: "go-panic", re: /goroutine \d+ \[[^\]]+\]:\s*[\s\S]+?(?=\n\n|$)/g, sub: "<stack>" },
    { name: "host-url", re: /https?:\/\/(?:[\w.-]+|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/g, sub: "https://<host>" },
];

function redact(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
        let out = value;
        for (const r of REDACTORS) out = out.replace(r.re, r.sub);
        return out;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value === "object") {
        const obj = {};
        for (const [k, v] of Object.entries(value)) obj[k] = redact(v);
        return obj;
    }
    return value;
}

function slugify(s) {
    return String(s ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function toolName(record) {
    const cat = slugify(record.category || "misc");
    const method = String(record.method || "get").toLowerCase();
    const pathSlug = slugify(record.path || "");
    let name = `panelica_${cat}_${method}_${pathSlug}`;
    if (name.length > 64) {
        const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
        name = `${name.slice(0, 55)}_${hash}`;
    }
    return name;
}

function buildInputSchema(record) {
    const properties = {};
    const required = [];
    const req = record.request || {};

    for (const p of req.path_params ?? []) {
        properties[p.name] = {
            type: p.type === "uuid" ? "string" : (p.type || "string"),
            description: p.description || `Path parameter: ${p.name}`,
        };
        if (p.required !== false) required.push(p.name);
    }
    for (const q of req.query_params ?? []) {
        properties[q.name] = {
            type: q.type || "string",
            description: q.description || `Query parameter: ${q.name}`,
        };
        if (q.required) required.push(q.name);
    }

    const body = req.body || {};
    if (body.fields?.length) {
        properties.body = {
            type: "object",
            description: `Request body (${body.content_type || "application/json"})`,
            properties: Object.fromEntries(body.fields.map(f => [f.name, {
                type: f.type === "uuid" ? "string" : (f.type || "string"),
                description: f.description || "",
            }])),
            required: body.fields.filter(f => f.required).map(f => f.name),
        };
        if (body.required) required.push("body");
    } else if (body.content_type && (record.method === "POST" || record.method === "PATCH" || record.method === "PUT")) {
        properties.body = {
            type: "object",
            description: `Request body (${body.content_type}). Schema not statically extractable — refer to API docs.`,
            additionalProperties: true,
        };
    }

    return {
        type: "object",
        properties,
        required: [...new Set(required)],
        additionalProperties: false,
    };
}

const tools = [];
const stats = { total: 0, external: 0, hmac: 0, emitted: 0, skipped: 0 };

for (const line of lines) {
    stats.total++;
    let record;
    try {
        record = JSON.parse(line);
    } catch {
        stats.skipped++;
        continue;
    }
    if (record.api_surface !== "external") continue;
    stats.external++;
    if (record.auth?.type !== "hmac") {
        stats.skipped++;
        continue;
    }
    stats.hmac++;

    const redacted = redact(record);

    const summary = redacted.summary || `${redacted.method} ${redacted.path}`;
    const description = [
        redacted.description || summary,
        `\nHTTP: ${redacted.method} ${redacted.path}`,
        `Category: ${redacted.category}`,
        redacted.auth?.scopes?.length ? `Required scopes: ${redacted.auth.scopes.join(", ")}` : "",
    ].filter(Boolean).join("\n");

    tools.push({
        name: toolName(redacted),
        description,
        inputSchema: buildInputSchema(redacted),
        metadata: {
            method: redacted.method,
            path: redacted.path,
            category: redacted.category,
            scopes: redacted.auth?.scopes ?? [],
        },
    });
    stats.emitted++;
}

writeFileSync(outputPath, JSON.stringify(tools, null, 2) + "\n");

console.log(`Total records:    ${stats.total}`);
console.log(`External:         ${stats.external}`);
console.log(`HMAC-protected:   ${stats.hmac}`);
console.log(`Emitted tools:    ${stats.emitted}`);
console.log(`Skipped:          ${stats.skipped}`);
console.log(`Output:           ${outputPath}`);
