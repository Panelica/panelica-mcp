/**
 * Toolsets — which of the 400+ catalogue tools are registered with the client.
 *
 * Why: MCP clients budget tools. Cursor caps active tools at about 40 across
 * all servers and silently drops the rest; every registered tool also costs
 * prompt tokens on each turn. So by default the server registers a compact
 * "core" set plus two meta tools that reach the whole catalogue:
 *
 *   panelica_find_tools  — keyword search over every catalogue tool
 *   panelica_call        — run any catalogue tool by name (same HMAC client)
 *
 * PANELICA_TOOLSETS (comma-separated, case-insensitive):
 *   core            curated everyday set (default)
 *   all             every catalogue tool (the pre-0.3 behaviour)
 *   none            only the two meta tools
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
    return {
        name: t.name,
        http: `${t.metadata.method} ${t.metadata.path}`,
        category: t.metadata.category,
        summary: t.description.split("\n")[0],
        params,
        body: bodyFields,
        scopes: t.metadata.scopes,
    };
}

/** The two meta tools, as MCP tool definitions. */
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
