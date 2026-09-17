#!/usr/bin/env node
/**
 * Panelica MCP Server
 *
 * Exposes the Panelica External API (HMAC-authenticated) as MCP tools so AI
 * assistants like Claude Desktop, Claude Code, Cursor and Codex can manage
 * hosting accounts, domains, databases, email, DNS, SSL, FTP, security, and
 * server resources through natural language.
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
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { buildTools, fetchSpec, type PanelicaTool } from "./catalog.js";

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

async function loadTools(): Promise<{ tools: PanelicaTool[]; source: string }> {
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
        return { tools, source: `live spec (${tools.length} tools${prov ? `, ${prov}` : ""})` };
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
        if (value === undefined || value === null) {
            throw new Error(`Missing required path parameter: ${key}`);
        }
        path = path.replace(`:${key}`, encodeURIComponent(String(value)));
        used.add(key);
    }
    return { path, queryUsed: used };
}

async function callPanelica(tool: PanelicaTool, args: CallArgs): Promise<string> {
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
        throw new Error(`Request to ${method} ${fullPath} failed: ${msg}`);
    } finally {
        clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
        throw new Error(
            `Panelica API ${response.status} ${response.statusText} on ${method} ${fullPath}:\n${text.slice(0, 4000)}`
        );
    }
    return text;
}

// ── Server ────────────────────────────────────────────────────────────────────
const { tools, source } = await loadTools();
const toolMap = new Map(tools.map((t) => [t.name, t]));
log(`v${VERSION} — catalogue from ${source}`);

const server = new Server(
    { name: "panelica-mcp", version: VERSION },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        // Safety hints let MCP clients auto-approve read-only calls and warn before
        // destructive ones (DELETE). Generated per HTTP method in catalog.ts.
        ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
        return {
            isError: true,
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
    try {
        const body = await callPanelica(tool, (args ?? {}) as CallArgs);
        return { content: [{ type: "text", text: body }] };
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
