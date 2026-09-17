/**
 * Server instructions — the orientation text an MCP client injects into the
 * model's context when it connects (MCP `initialize` → `instructions`).
 *
 * Generated from the loaded catalogue so it never promises a tool or path the
 * panel does not have: category counts come from the tools, and each workflow
 * recipe is included only when every step exists in this catalogue.
 */

import type { PanelicaTool } from "./catalog.js";
import { META_CALL, META_DESCRIBE, META_FIND } from "./toolsets.js";

export interface InstructionInput {
    tools: PanelicaTool[];      // full catalogue
    registered: PanelicaTool[]; // what tools/list exposes (meta tools excluded)
    toolsets: string[];
    source: string;             // "live spec (…)" | "snapshot (…)"
    panelVersion?: string;
}

interface Recipe { title: string; steps: string[]; }

const RECIPES: Recipe[] = [
    { title: "Find the id of anything", steps: ["GET /v1/search", "GET /v1/domains", "GET /v1/accounts"] },
    { title: "Provision a hosting account with a site", steps: ["POST /v1/accounts", "POST /v1/domains", "POST /v1/ssl/domains/:domain_id/issue", "POST /v1/databases", "POST /v1/email-accounts"] },
    { title: "Inspect one site", steps: ["GET /v1/domains", "GET /v1/domains/:id", "GET /v1/ssl/domains/:domain_id", "GET /v1/dns/zones/:domain_id/records", "GET /v1/domains/:id/subdomains"] },
    { title: "Change PHP version", steps: ["GET /v1/domains", "PATCH /v1/domains/:id/php"] },
    { title: "Add or fix a DNS record", steps: ["GET /v1/dns/zones/:domain_id/records", "POST /v1/dns/zones/:domain_id/records", "PATCH /v1/dns/records/:id"] },
    { title: "Server health", steps: ["GET /v1/server/status", "GET /v1/server/services", "GET /v1/server/metrics", "POST /v1/server/services/:name/restart"] },
    { title: "Backups", steps: ["GET /v1/backups", "POST /v1/backups", "GET /v1/backup-schedules"] },
    { title: "WordPress maintenance", steps: ["GET /v1/wordpress", "POST /v1/wordpress/:id/update-core"] },
];

export function buildInstructions(i: InstructionInput): string {
    const have = new Set(i.tools.map((t) => `${t.metadata.method} ${t.metadata.path}`));
    const byCat = new Map<string, number>();
    for (const t of i.tools) byCat.set(t.metadata.category, (byCat.get(t.metadata.category) ?? 0) + 1);
    const cats = [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, n]) => `${c} (${n})`).join(", ");
    const recipes = RECIPES.filter((r) => r.steps.every((s) => have.has(s)))
        .map((r) => `- ${r.title}: ${r.steps.join(" → ")}`);
    const lists = i.tools.filter((t) => t.metadata.method === "GET" && !t.metadata.path.includes(":")).length;

    return [
        `Panelica MCP: ${i.tools.length} tools = the Panelica hosting-panel External API${i.panelVersion ? ` (panel ${i.panelVersion})` : ""}, catalogue from ${i.source}. ` +
        `${i.registered.length} tools are registered directly (toolsets: ${i.toolsets.join(",")}); the rest are one search away.`,
        "",
        "HOW CALLS WORK",
        "- Each tool is one HTTP endpoint (method + path in its description). Authentication (HMAC) is done by this server with the operator's API key — never ask the user for credentials.",
        "- Every id (id, domain_id, user_id, zone_id …) is a UUID that must come from a list call first (GET /v1/domains, GET /v1/accounts …); each parameter's description says where. Never invent, guess or reuse an id from memory.",
        "- Users are called accounts: user_id values come from GET /v1/accounts.",
        `- Success responses are {\"status\":\"success\",\"data\":…} (sometimes with \"total\" or \"message\"). ${lists} list tools return all items the key's owner may see, unpaginated unless the tool has page/limit parameters; oversized results are cut to the first items with a _truncated note.`,
        "- Errors come back as text starting with \"Panelica API error <status>\" plus what to do: 403 = the key lacks a scope (ask the operator, do not retry); 404 = wrong id (re-list); 409 = conflict/not configured; 429 = rate limit (wait for the reset shown); 5xx = panel fault (report, do not loop).",
        "- Read-only keys see 403 on every mutating call; scopes are per family (domains:read, dns:write, *:read …).",
        "",
        "FINDING THE RIGHT TOOL",
        `- ${META_FIND}(query) searches all ${i.tools.length} tools by keyword; ${META_DESCRIBE}(tool) returns a tool's exact parameters, body fields and response fields; ${META_CALL}(tool, arguments) runs any catalogue tool, registered or not.`,
        `- Categories: ${cats}.`,
        "- Prefer one list call over many single GETs (rate limits are per minute). Use GET /v1/search when you only have a name.",
        "",
        "SAFETY",
        "- GET tools are safe to run freely. POST/PUT/PATCH change server state; DELETE is permanent. Before deleting, suspending, restoring, restarting services or changing PHP/DNS/SSL, state exactly what will change and get the user's confirmation.",
        "- Act only on resources the user named; if a name matches several resources, show them and ask.",
        "- Do not echo passwords, API secrets or tokens from responses unless the user explicitly asks for them.",
        "",
        recipes.length ? "COMMON WORKFLOWS (all steps exist in this catalogue)" : "",
        ...recipes,
    ].filter((l, idx, arr) => !(l === "" && arr[idx - 1] === "")).join("\n");
}
