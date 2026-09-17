/**
 * Catalogue builder — turns a Panelica External API spec (`/v1/api-spec`) into
 * MCP tool definitions.
 *
 * ZERO-DRIFT by construction: the backend generates the spec at runtime from its
 * route registry, so every tool here mirrors a real endpoint. The same code path
 * serves two consumers:
 *   - tools/build-tools.mjs   → writes the committed tools/tools.json snapshot
 *   - src/index.ts             → live mode: fetches the spec from the operator's
 *                                own panel at startup and builds tools in memory
 *
 * Everything user-visible passes through redactStr(): UUIDs, private IPs,
 * e-mail addresses and panel paths from the spec never reach an LLM prompt or
 * the public repository.
 *
 * MCP tool name format: panelica_<category-slug>_<method>_<path-slug> (≤ 64 chars).
 */

import { createHash } from "node:crypto";

// ── Spec shapes (subset we rely on) ───────────────────────────────────────────
export interface SpecParam { name: string; type?: string; required?: boolean; description?: string; }
export interface SpecBodyField { name: string; type?: string; required?: boolean; description?: string; }
export interface SpecEndpoint {
    method: string;
    path: string;
    category?: string;
    summary?: string;
    description?: string;
    auth?: { required?: boolean; type?: string; scopes?: string[] };
    request?: {
        path_params?: SpecParam[];
        query_params?: SpecParam[];
        body?: { content_type?: string; required?: boolean; fields?: SpecBodyField[] };
    };
}
export interface ApiSpec {
    version?: string;
    panel_version?: string;
    generated_at?: string;
    base_url?: string;
    endpoints?: SpecEndpoint[];
    [k: string]: unknown;
}

// ── Tool shape ────────────────────────────────────────────────────────────────
export interface ToolMetadata { method: string; path: string; category: string; scopes: string[]; }
export interface PanelicaTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    metadata: ToolMetadata;
}

// ── Redaction ─────────────────────────────────────────────────────────────────
// Defensive: the spec is metadata, but a panel operator may have customised
// descriptions. Nothing that looks like an identifier or an address gets through.
const REDACTORS: { re: RegExp; sub: string }[] = [
    { re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, sub: "<uuid>" },
    // Any IPv4 (private or public), with an optional :port.
    { re: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g, sub: "<ip>" },
    { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, sub: "<email>" },
    { re: /\/opt\/panelica[\w/.-]*/g, sub: "<path>" },
    { re: /\/home\/[\w.-]+[\w/.-]*/g, sub: "<path>" },
    { re: /\b(?:pk|sk)_[A-Za-z0-9]{8,}\b/g, sub: "<key>" },
];
export function redactStr(s: unknown): string {
    let out = String(s ?? "");
    for (const r of REDACTORS) out = out.replace(r.re, r.sub);
    return out;
}
/** Deep-redact a whole spec (used before the snapshot is written to the public repo). */
export function deepRedact<T>(v: T): T {
    if (typeof v === "string") return redactStr(v) as unknown as T;
    if (Array.isArray(v)) return v.map(deepRedact) as unknown as T;
    if (v && typeof v === "object") {
        const o: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = deepRedact(val);
        return o as T;
    }
    return v;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
/** The spec renders path params as {name}; the runtime substitutes :name. */
export function toColonPath(p: string): string {
    return String(p ?? "").replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, ":$1");
}
function slugify(s: unknown): string {
    return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
function toolName(method: string, path: string, category: string | undefined): string {
    const cat = slugify(category || "misc");
    const m = String(method || "get").toLowerCase();
    let name = `panelica_${cat}_${m}_${slugify(path)}`;
    if (name.length > 64) {
        const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
        name = `${name.slice(0, 55)}_${hash}`;
    }
    return name;
}
function jsonType(t: string | undefined): string {
    return t === "uuid" ? "string" : (t || "string");
}

function buildInputSchema(ep: SpecEndpoint): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
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
    if (body.content_type === "none") {
        // The panel declares this mutating endpoint takes no request body
        // (action endpoints such as …/suspend, …/restart): no body property.
    } else if (body.fields?.length) {
        properties.body = {
            type: "object",
            description: `Request body (${body.content_type || "application/json"})`,
            properties: Object.fromEntries(body.fields.map((f) => [f.name, {
                type: jsonType(f.type),
                description: redactStr(f.description || ""),
            }])),
            required: body.fields.filter((f) => f.required).map((f) => f.name),
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

/** MCP tool annotations: clients auto-approve read-only calls and warn before destructive ones. */
function annotations(ep: SpecEndpoint): Record<string, unknown> {
    const m = String(ep.method || "GET").toUpperCase();
    const readOnly = m === "GET" || m === "HEAD";
    const destructive = m === "DELETE";
    return {
        title: redactStr(ep.summary || `${m} ${ep.path}`),
        readOnlyHint: readOnly,
        destructiveHint: destructive,
        idempotentHint: readOnly || m === "PUT" || m === "DELETE",
        openWorldHint: true, // reaches an external panel over the network
    };
}

function buildDescription(ep: SpecEndpoint): string {
    const colon = toColonPath(ep.path);
    const scopes = ep.auth?.scopes?.length ? `Required scopes: ${ep.auth.scopes.join(", ")}` : "";
    const risk = ep.method === "DELETE"
        ? "WARNING: destructive — permanently removes the resource."
        : (["POST", "PUT", "PATCH"].includes(ep.method) ? "Mutating: changes server state." : "Read-only.");
    return [
        redactStr(ep.description || ep.summary || `${ep.method} ${colon}`),
        `\nHTTP: ${ep.method} ${colon}`,
        `Category: ${redactStr(ep.category)}`,
        scopes,
        risk,
    ].filter(Boolean).join("\n");
}

/** Meta / non-REST endpoints that are not tools (unauthenticated, WebSocket, ticket minting for WS). */
const SKIP_PATHS = /^\/(health|v1\/api-spec|v1\/postman-collection|v1\/metrics\/ws|v1\/metrics\/ws-ticket|v1\/terminal\/ws)$/;

export interface BuildStats { total: number; emitted: number; skipped: number; read: number; mutate: number; destructive: number; }

/** Build the sorted tool list from a spec. Pure; no I/O. */
export function buildTools(spec: ApiSpec): { tools: PanelicaTool[]; stats: BuildStats } {
    const endpoints = spec.endpoints ?? [];
    const stats: BuildStats = { total: endpoints.length, emitted: 0, skipped: 0, read: 0, mutate: 0, destructive: 0 };
    const seen = new Set<string>();
    const tools: PanelicaTool[] = [];

    for (const ep of endpoints) {
        if (!ep.method || !ep.path) { stats.skipped++; continue; }
        if (SKIP_PATHS.test(ep.path)) { stats.skipped++; continue; }

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
                category: redactStr(ep.category || "misc"),
                scopes: ep.auth?.scopes ?? [],
            },
        });
        stats.emitted++;
    }

    tools.sort((a, b) => a.name.localeCompare(b.name));
    return { tools, stats };
}

/**
 * Fetch a live spec. The response envelope is {status, data} on the panel; a
 * bare spec is accepted too. Rejects on non-2xx, timeout or a malformed body.
 * The caller decides whether to fall back to the committed snapshot.
 */
export async function fetchSpec(url: string, timeoutMs: number): Promise<ApiSpec> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctrl.signal });
        if (!res.ok) throw new Error(`spec fetch failed: HTTP ${res.status}`);
        const json = (await res.json()) as { data?: ApiSpec } & ApiSpec;
        const spec = (json.data ?? json) as ApiSpec;
        if (!Array.isArray(spec.endpoints)) throw new Error("spec has no endpoints array");
        return spec;
    } finally {
        clearTimeout(timer);
    }
}
