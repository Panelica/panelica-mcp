#!/usr/bin/env node
/**
 * Panelica MCP Server
 *
 * Exposes the Panelica External API (HMAC-authenticated) as MCP tools so AI
 * assistants like Claude Desktop, Claude Code, Cursor and Codex can manage
 * hosting accounts, domains, databases, email, DNS, SSL, FTP, security, and
 * server resources through natural language.
 *
 * What the connecting model gets, beyond the tools themselves:
 *   - server instructions (MCP initialize): how ids, scopes, envelopes, errors
 *     and rate limits work, plus workflow recipes — generated from the catalogue
 *   - per-tool "Returns:" lines and id-parameter provenance in every description
 *   - panelica_describe_tool for exact parameters + response fields
 *   - errors translated into what to do next (missing scope, wrong id, wait…)
 *   - resources: panelica://guide, panelica://catalogue, panelica://spec
 *
 * Environment variables:
 *   PANELICA_BASE_URL    Base URL of the External API
 *                        (e.g. https://panel.example.com:8443/api/external)
 *   PANELICA_API_KEY     External API key (panel: Settings -> API Keys)
 *   PANELICA_API_SECRET  API secret paired with the key above
 *   PANELICA_TIMEOUT_MS  Optional request timeout (default 30000)
 *   PANELICA_LIVE_SPEC   "1" (default): at startup fetch <BASE_URL>/v1/api-spec
 *                        from YOUR panel and build the tool list from it, so the
 *                        catalogue always matches the panel version you run.
 *                        "0": use only the committed tools/tools.json snapshot.
 *                        A live fetch that fails (unreachable panel, self-signed
 *                        certificate not trusted, timeout) falls back to the
 *                        snapshot — the server always starts.
 *   PANELICA_SPEC_TIMEOUT_MS  Optional live-spec fetch timeout (default 8000)
 *   PANELICA_TOOLSETS    Which tools to register (default "core"): "core", "all",
 *                        "none" or category slugs, comma-separated — see
 *                        src/toolsets.ts. Three meta tools (panelica_find_tools,
 *                        panelica_describe_tool, panelica_call) always give
 *                        access to the whole catalogue.
 *   PANELICA_MAX_RESULT_CHARS  Optional cap on a tool result (default 60000);
 *                        larger list results are cut to the first items with a
 *                        _truncated note so the client context is not flooded.
 *
 * Run:
 *   panelica-mcp                 # stdio transport (default for Claude Desktop)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { buildTools, fetchSpec, type ApiSpec, type PanelicaTool } from "./catalog.js";
import { boundResult, explainError } from "./errors.js";
import { buildInstructions } from "./instructions.js";
import { META_CALL, META_DESCRIBE, META_FIND, describeTool, findTools, metaTools, parseToolsets, selectTools, summarize } from "./toolsets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Single source of truth for the version: package.json (bumped by the release
// workflow). No hand-maintained copies.
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as { version: string };
const VERSION: string = pkg.version;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) {
        throw new Error(
            `Missing required environment variable: ${name}.\n` +
            `Generate an API key/secret pair in your Panelica panel (Settings -> API Keys) and set:\n` +
            `  PANELICA_BASE_URL    e.g. https://panel.example.com:8443/api/external\n` +
            `  PANELICA_API_KEY     X-API-Key value\n` +
            `  PANELICA_API_SECRET  paired secret`
        );
    }
    return v;
}

// stderr only: stdout is the MCP JSON-RPC channel and must stay clean.
function log(msg: string): void {
    process.stderr.write(`[panelica-mcp] ${msg}\n`);
}

// ── Tool catalogue: live spec (default) with snapshot fallback ────────────────
const snapshotPath = resolve(__dirname, "../tools/tools.json");
const snapshotTools: PanelicaTool[] = JSON.parse(readFileSync(snapshotPath, "utf8"));

interface Loaded { tools: PanelicaTool[]; source: string; spec?: ApiSpec; panelVersion?: string; }

async function loadTools(): Promise<Loaded> {
    const live = (process.env.PANELICA_LIVE_SPEC ?? "1") !== "0";
    const baseUrl = (process.env.PANELICA_BASE_URL ?? "").replace(/\/+$/, "");
    if (!live || !baseUrl) {
        return { tools: snapshotTools, source: `snapshot (${snapshotTools.length} tools)` };
    }
    const timeoutMs = Number(process.env.PANELICA_SPEC_TIMEOUT_MS ?? 8_000);
    try {
        const spec = await fetchSpec(`${baseUrl}/v1/api-spec`, timeoutMs);
        const { tools } = buildTools(spec);
        if (tools.length === 0) throw new Error("live spec produced no tools");
        const prov = [spec.panel_version ? `panel ${spec.panel_version}` : "", spec.generated_at ?? ""].filter(Boolean).join(" ");
        return { tools, source: `live spec (${tools.length} tools${prov ? `, ${prov}` : ""})`, spec, panelVersion: spec.panel_version };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`live spec unavailable (${msg}); using committed snapshot (${snapshotTools.length} tools)`);
        return { tools: snapshotTools, source: `snapshot (${snapshotTools.length} tools)` };
    }
}

// ── HMAC client ───────────────────────────────────────────────────────────────
function sign(method: string, fullPath: string, timestamp: string, body: string, secret: string): string {
    // Backend formula: HMAC-SHA256(METHOD + PATH + TIMESTAMP + BODY, SECRET)
    // DELETE requests exclude body from the signature.
    const bodyForSign = method === "DELETE" ? "" : body;
    const stringToSign = method + fullPath + timestamp + bodyForSign;
    return createHmac("sha256", secret).update(stringToSign).digest("hex");
}

interface CallArgs {
    [key: string]: unknown;
    body?: Record<string, unknown>;
}

function buildPathAndQuery(template: string, args: CallArgs): { path: string; queryUsed: Set<string> } {
    // Substitute :param style placeholders from args.
    let path = template;
    const used = new Set<string>();
    for (const m of template.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
        const key = m[1];
        const value = args[key];
        if (value === undefined || value === null || value === "") {
            throw new Error(`Missing required path parameter "${key}" for ${template}. Its value is an id from a list call — see ${META_DESCRIBE}.`);
        }
        path = path.replace(`:${key}`, encodeURIComponent(String(value)));
        used.add(key);
    }
    return { path, queryUsed: used };
}

interface CallResult { ok: boolean; text: string; }

async function callPanelica(tool: PanelicaTool, args: CallArgs): Promise<CallResult> {
    const baseUrl = requireEnv("PANELICA_BASE_URL").replace(/\/+$/, "");
    const apiKey = requireEnv("PANELICA_API_KEY");
    const apiSecret = requireEnv("PANELICA_API_SECRET");
    const timeoutMs = Number(process.env.PANELICA_TIMEOUT_MS ?? 30_000);

    const { method, path: pathTemplate } = tool.metadata;
    const { path: resolvedPath, queryUsed } = buildPathAndQuery(pathTemplate, args);

    // Remaining args that are not path params and not body -> query string.
    const queryParams = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) {
        if (k === "body" || queryUsed.has(k) || v === undefined || v === null) continue;
        queryParams.append(k, String(v));
    }
    const queryString = queryParams.toString();
    const fullPath = queryString ? `${resolvedPath}?${queryString}` : resolvedPath;

    const bodyString = args.body !== undefined ? JSON.stringify(args.body) : "";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = sign(method, fullPath, timestamp, bodyString, apiSecret);

    const headers: Record<string, string> = {
        "X-API-Key": apiKey,
        "X-Timestamp": timestamp,
        "X-Signature": signature,
        "Accept": "application/json",
        "User-Agent": `panelica-mcp/${VERSION}`,
    };
    if (bodyString) headers["Content-Type"] = "application/json";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let response: Response;
    try {
        response = await fetch(`${baseUrl}${fullPath}`, {
            method,
            headers,
            body: bodyString || undefined,
            signal: ctrl.signal,
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const why = /abort/i.test(msg)
            ? `timed out after ${timeoutMs} ms — the panel did not answer in time (long operation or unreachable host). Do not loop on retries; try once more later or tell the operator.`
            : `${msg} — the panel is unreachable from this machine (URL, DNS, firewall or TLS). Nothing to fix from the conversation; tell the operator to check PANELICA_BASE_URL.`;
        return { ok: false, text: `Request ${method} ${fullPath} failed: ${why}` };
    } finally {
        clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
        const hdrs: Record<string, string> = {};
        response.headers.forEach((v, k) => { hdrs[k] = v; });
        return { ok: false, text: explainError({ status: response.status, statusText: response.statusText, method, path: fullPath, body: text, headers: hdrs }) };
    }
    return { ok: true, text: boundResult(text, Number(process.env.PANELICA_MAX_RESULT_CHARS ?? 60_000)) };
}

// ── Server ────────────────────────────────────────────────────────────────────
const loaded = await loadTools();
const { tools, source } = loaded;
// Full catalogue (reachable through panelica_call) vs. the registered subset
// (what the client sees in tools/list). See src/toolsets.ts for the rationale.
const toolMap = new Map(tools.map((t) => [t.name, t]));
const toolsets = parseToolsets(process.env.PANELICA_TOOLSETS);
const registered = selectTools(tools, toolsets);
const exposed: PanelicaTool[] = [...metaTools(tools.length, registered.length), ...registered];
const instructions = buildInstructions({ tools, registered, toolsets, source, panelVersion: loaded.panelVersion });
log(`v${VERSION} — catalogue from ${source}; toolsets=${toolsets.join(",")} → ${exposed.length} tools registered`);

const server = new Server(
    { name: "panelica-mcp", version: VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposed.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        // Safety hints let MCP clients auto-approve read-only calls and warn before
        // destructive ones (DELETE). Generated per HTTP method in catalog.ts.
        ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
}));

// ── Resources: the same knowledge, attachable by clients that support resources ──
const RESOURCES = [
    { uri: "panelica://guide", name: "Panelica API guide", description: "How ids, scopes, envelopes, errors and rate limits work; workflow recipes.", mimeType: "text/plain" },
    { uri: "panelica://catalogue", name: "Panelica tool catalogue", description: `All ${tools.length} tools: name, HTTP method/path, category, one-line summary.`, mimeType: "application/json" },
    ...(loaded.spec ? [{ uri: "panelica://spec", name: "Panelica External API spec", description: "The panel's live /v1/api-spec (endpoints, parameters, response fields).", mimeType: "application/json" }] : []),
];

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    switch (uri) {
        case "panelica://guide":
            return { contents: [{ uri, mimeType: "text/plain", text: instructions }] };
        case "panelica://catalogue":
            return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(tools.map((t) => ({ name: t.name, http: `${t.metadata.method} ${t.metadata.path}`, category: t.metadata.category, summary: t.description.split("\n")[0] }))) }] };
        case "panelica://spec":
            if (loaded.spec) return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(loaded.spec) }] };
            break;
    }
    throw new Error(`Unknown resource: ${uri}`);
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    if (name === META_FIND) {
        const hits = findTools(tools, String(a.query ?? ""), Number(a.limit ?? 10));
        const text = hits.length
            ? JSON.stringify({ count: hits.length, tools: hits.map(summarize), next: `Run one with ${META_CALL}(tool, arguments); ${META_DESCRIBE}(tool) shows its full parameters and response fields.` }, null, 1)
            : JSON.stringify({ count: 0, hint: "No tool matched every keyword. Try fewer or different words (resource names such as 'domain', 'dns', 'ssl', 'backup', 'wordpress'), or read the panelica://catalogue resource." });
        return { content: [{ type: "text", text }] };
    }
    if (name === META_DESCRIBE) {
        const t = toolMap.get(String(a.tool ?? ""));
        if (!t) return { isError: true, content: [{ type: "text", text: `Unknown catalogue tool: ${String(a.tool ?? "")}. Use ${META_FIND} to search.` }] };
        return { content: [{ type: "text", text: JSON.stringify(describeTool(t), null, 1) }] };
    }

    let tool: PanelicaTool | undefined;
    let callArgs: CallArgs;
    if (name === META_CALL) {
        tool = toolMap.get(String(a.tool ?? ""));
        callArgs = ((a.arguments ?? {}) as CallArgs);
        if (!tool) {
            return { isError: true, content: [{ type: "text", text: `Unknown catalogue tool: ${String(a.tool ?? "")}. Use ${META_FIND} to search.` }] };
        }
    } else {
        // Direct calls are accepted for every catalogue tool, registered or not.
        tool = toolMap.get(name);
        callArgs = a as CallArgs;
    }
    if (!tool) {
        return {
            isError: true,
            content: [{ type: "text", text: `Unknown tool: ${name}. Use ${META_FIND} to search the catalogue.` }],
        };
    }
    try {
        const r = await callPanelica(tool, callArgs);
        return { ...(r.ok ? {} : { isError: true }), content: [{ type: "text", text: r.text }] };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            isError: true,
            content: [{ type: "text", text: msg }],
        };
    }
});

const transport = new StdioServerTransport();
await server.connect(transport);
