/**
 * Toolsets — which of the 400+ catalogue tools are registered with the client.
 *
 * Why: MCP clients budget tools. Cursor caps active tools at about 40 across
 * all servers and silently drops the rest; every registered tool also costs
 * prompt tokens on each turn. So by default the server registers a compact
 * "core" set plus three meta tools that reach the whole catalogue:
 *
 *   panelica_find_tools     — keyword search over every catalogue tool
 *   panelica_describe_tool  — exact parameters + response fields of one tool
 *   panelica_call           — run any catalogue tool by name (same HMAC client)
 *
 * PANELICA_TOOLSETS (comma-separated, case-insensitive):
 *   core            curated everyday set (default)
 *   all             every catalogue tool (the pre-0.3 behaviour)
 *   none            only the meta tools
 *   <category>      a category slug, e.g. domains, dns, ssl, git, docker,
 *                   file_manager, laravel_apps, node_js_apps, python_apps
 *   Entries are unioned: "core,git" = core + all Git tools.
 */

import type { PanelicaTool } from "./catalog.js";

/** Curated everyday tools (METHOD path). Order is irrelevant; presence is what matters. */
export const CORE_TOOLS: readonly string[] = [
    "GET /v1/me",
    "GET /v1/search",
    "GET /v1/accounts",
    "POST /v1/accounts",
    "GET /v1/accounts/:id",
    "POST /v1/accounts/:id/suspend",
    "POST /v1/accounts/:id/unsuspend",
    "GET /v1/domains",
    "POST /v1/domains",
    "GET /v1/domains/:id",
    "PATCH /v1/domains/:id/php",
    "GET /v1/domains/:id/subdomains",
    "POST /v1/domains/:id/subdomains",
    "GET /v1/dns/zones/:domain_id/records",
    "POST /v1/dns/zones/:domain_id/records",
    "PATCH /v1/dns/records/:id",
    "GET /v1/ssl/domains/:domain_id",
    "POST /v1/ssl/domains/:domain_id/issue",
    "GET /v1/databases",
    "POST /v1/databases",
    "GET /v1/email-accounts",
    "POST /v1/email-accounts",
    "GET /v1/ftp-accounts",
    "POST /v1/ftp-accounts",
    "GET /v1/backups",
    "POST /v1/backups",
    "GET /v1/server/status",
    "GET /v1/server/services",
    "GET /v1/server/metrics",
    "POST /v1/server/services/:name/restart",
    "GET /v1/wordpress",
    "POST /v1/wordpress/:id/update-core",
    "GET /v1/docker/containers",
    "GET /v1/plans",
];

export const META_FIND = "panelica_find_tools";
export const META_CALL = "panelica_call";
export const META_DESCRIBE = "panelica_describe_tool";

export function categorySlug(category: string): string {
    return String(category ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Parse PANELICA_TOOLSETS; empty/undefined → ["core"]. */
export function parseToolsets(raw: string | undefined): string[] {
    const parts = String(raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return parts.length ? parts : ["core"];
}

/** Select the tools to register for the given toolsets (meta tools excluded). */
export function selectTools(all: PanelicaTool[], toolsets: string[]): PanelicaTool[] {
    if (toolsets.includes("all")) return all;
    const core = new Set(CORE_TOOLS);
    const wantCore = toolsets.includes("core");
    const cats = new Set(toolsets.filter((t) => t !== "core" && t !== "none" && t !== "all"));
    return all.filter((t) => {
        const key = `${t.metadata.method} ${t.metadata.path}`;
        if (wantCore && core.has(key)) return true;
        return cats.has(categorySlug(t.metadata.category));
    });
}

/** Keyword search: every term must appear in name, path, category or description. */
export function findTools(all: PanelicaTool[], query: string, limit = 10): PanelicaTool[] {
    const terms = String(query ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (terms.length === 0) return [];
    const scored = all.map((t) => {
        const hay = `${t.name} ${t.metadata.method} ${t.metadata.path} ${t.metadata.category} ${t.description}`.toLowerCase();
        let score = 0;
        for (const term of terms) {
            if (!hay.includes(term)) return null;
            // Prefer matches in the path / category over description-only hits.
            if (t.metadata.path.toLowerCase().includes(term)) score += 3;
            if (t.metadata.category.toLowerCase().includes(term)) score += 2;
            score += 1;
        }
        if (t.metadata.method === "GET") score += 0.5; // reads first when tied
        return { t, score };
    }).filter((x): x is { t: PanelicaTool; score: number } => x !== null);
    scored.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
    return scored.slice(0, Math.max(1, Math.min(50, limit))).map((x) => x.t);
}

/** Compact, LLM-friendly summary of a tool for find results. */
export function summarize(t: PanelicaTool): Record<string, unknown> {
    const props = (t.inputSchema as { properties?: Record<string, { type?: string; properties?: Record<string, unknown>; required?: string[] }> }).properties ?? {};
    const required = ((t.inputSchema as { required?: string[] }).required ?? []);
    const params = Object.entries(props).filter(([k]) => k !== "body").map(([k, v]) => `${k}${required.includes(k) ? "*" : ""}:${v.type ?? "string"}`);
    const body = props.body;
    const bodyFields = body?.properties ? Object.keys(body.properties).map((k) => `${k}${(body.required ?? []).includes(k) ? "*" : ""}`) : (body ? ["(free-form object)"] : []);
    const r = t.metadata.response;
    const returns = r ? (r.data_type === "none" ? `{status, ${(r.fields ?? []).map((f) => f.name).join(", ")}}` : `${r.data_type}${r.fields?.length ? ` of {${r.fields.slice(0, 10).map((f) => f.name).join(", ")}${r.fields.length > 10 ? ", …" : ""}}` : ""}`) : undefined;
    return {
        name: t.name,
        http: `${t.metadata.method} ${t.metadata.path}`,
        category: t.metadata.category,
        summary: t.description.split("\n")[0],
        params,
        body: bodyFields,
        ...(returns ? { returns } : {}),
        scopes: t.metadata.scopes,
    };
}

/** Everything a caller needs to use one tool correctly: full input schema + response fields. */
export function describeTool(t: PanelicaTool): Record<string, unknown> {
    const schema = t.inputSchema as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const params = Object.entries(props).filter(([k]) => k !== "body").map(([k, v]) => ({ name: k, type: v.type ?? "string", required: required.has(k), description: v.description ?? "" }));
    const body = props.body as { properties?: Record<string, Record<string, unknown>>; required?: string[]; additionalProperties?: boolean } | undefined;
    const bodyReq = new Set(body?.required ?? []);
    const bodyFields = body?.properties
        ? Object.entries(body.properties).map(([k, v]) => ({ name: k, type: v.type ?? "string", required: bodyReq.has(k), description: v.description ?? "" }))
        : undefined;
    const r = t.metadata.response;
    return {
        name: t.name,
        http: `${t.metadata.method} ${t.metadata.path}`,
        category: t.metadata.category,
        description: t.description.split("\n")[0],
        scopes: t.metadata.scopes,
        risk: t.metadata.method === "DELETE" ? "destructive" : (t.metadata.method === "GET" ? "read-only" : "mutating"),
        params,
        body: body ? (bodyFields ?? "free-form object — see the panel's API docs") : "none",
        body_required: required.has("body"),
        response: r
            ? { envelope: r.data_type === "none" ? "{status, …keys}" : `{status, data: ${r.data_type}${r.keys?.length ? ", " + r.keys.join(", ") : ""}}`, fields: r.fields ?? [] }
            : { envelope: "{status, data}", fields: [], note: "field list not available for this panel version" },
    };
}

/** The meta tools (find / describe / call), as MCP tool definitions. */
export function metaTools(catalogueSize: number, registered: number): PanelicaTool[] {
    return [
        {
            name: META_FIND,
            description:
                `Search the full Panelica tool catalogue (${catalogueSize} tools; ${registered} are registered directly). ` +
                `Use this when no registered tool fits: returns matching tools with their parameters, then run one with ${META_CALL}.\n` +
                `Read-only.`,
            inputSchema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Keywords, e.g. 'dns records', 'wordpress update', 'ssl issue'" },
                    limit: { type: "integer", description: "Max results (default 10, max 50)" },
                },
                required: ["query"],
                additionalProperties: false,
            },
            annotations: { title: "Find Panelica tools", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            metadata: { method: "GET", path: "(catalogue)", category: "Meta", scopes: [] },
        },
        {
            name: META_DESCRIBE,
            description:
                `Describe one Panelica catalogue tool by name: exact path/query parameters, request body fields (types, required) and the response envelope with its data fields. ` +
                `Use it before calling a tool whose arguments or result shape you are unsure about.\nRead-only.`,
            inputSchema: {
                type: "object",
                properties: { tool: { type: "string", description: "Catalogue tool name, e.g. panelica_domains_get_v1_domains_id" } },
                required: ["tool"],
                additionalProperties: false,
            },
            annotations: { title: "Describe a Panelica tool", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            metadata: { method: "GET", path: "(catalogue)", category: "Meta", scopes: [] },
        },
        {
            name: META_CALL,
            description:
                `Run any Panelica catalogue tool by name (as returned by ${META_FIND}) with its arguments. ` +
                `Path params, query params and 'body' follow that tool's schema. ` +
                `Mutating or destructive depending on the underlying tool — check its HTTP method first.`,
            inputSchema: {
                type: "object",
                properties: {
                    tool: { type: "string", description: "Catalogue tool name, e.g. panelica_domains_get_v1_domains" },
                    arguments: { type: "object", description: "Arguments for that tool", additionalProperties: true },
                },
                required: ["tool"],
                additionalProperties: false,
            },
            annotations: { title: "Call a Panelica tool", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
            metadata: { method: "ANY", path: "(catalogue)", category: "Meta", scopes: [] },
        },
    ];
}
