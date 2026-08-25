#!/usr/bin/env node
/**
 * Panelica MCP Server
 *
 * Exposes the Panelica External API (266 endpoints, HMAC-authenticated) as MCP
 * tools so AI assistants like Claude Desktop, Cursor, and ChatGPT can manage
 * hosting accounts, domains, databases, email, DNS, SSL, FTP, security, and
 * server resources through natural language.
 *
 * Environment variables:
 *   PANELICA_BASE_URL   Base URL of the External API (e.g. https://panel.example.com:3002)
 *   PANELICA_API_KEY    External API key (from panel: Settings -> API Keys)
 *   PANELICA_API_SECRET External API secret (paired with the key above)
 *   PANELICA_TIMEOUT_MS Optional request timeout (default 30000)
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

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ToolMetadata {
    method: string;
    path: string;
    category: string;
    scopes: string[];
}

interface PanelicaTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    metadata: ToolMetadata;
}

const toolsPath = resolve(__dirname, "../tools/tools.json");
const tools: PanelicaTool[] = JSON.parse(readFileSync(toolsPath, "utf8"));
const toolMap = new Map(tools.map(t => [t.name, t]));

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) {
        throw new Error(
            `Missing required environment variable: ${name}.\n` +
            `Generate an API key/secret pair in your Panelica panel (Settings -> API Keys) and set:\n` +
            `  PANELICA_BASE_URL    e.g. https://panel.example.com:3002\n` +
            `  PANELICA_API_KEY     X-API-Key value\n` +
            `  PANELICA_API_SECRET  paired secret`
        );
    }
    return v;
}

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
        "User-Agent": "panelica-mcp/0.2.0",
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

const server = new Server(
    { name: "panelica-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        // Safety hints let MCP clients auto-approve read-only calls and warn before
        // destructive ones (DELETE). Generated per HTTP method by build-tools.mjs.
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
