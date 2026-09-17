# Panelica MCP Server

> Talk to your [Panelica](https://panelica.com) hosting panel in plain English.
> Provision a domain, issue an SSL certificate, create a database, or restart a
> service through Claude Desktop, Cursor, ChatGPT, or any other
> [Model Context Protocol](https://modelcontextprotocol.io) client.

[![npm](https://img.shields.io/npm/v/panelica-mcp?color=CB3837&logo=npm)](https://www.npmjs.com/package/panelica-mcp)
[![Tools](https://img.shields.io/badge/tools-404-blue)](tools/tools.json)
[![Scopes](https://img.shields.io/badge/permission%20scopes-50-8A2BE2)](#permission-scopes)
[![Docker](https://img.shields.io/badge/ghcr.io-panelica%2Fpanelica--mcp-2496ED?logo=docker&logoColor=white)](https://github.com/Panelica/panelica-mcp/pkgs/container/panelica-mcp)
[![Zero drift](https://img.shields.io/badge/catalogue-auto--generated%20weekly-brightgreen)](#keeping-the-tool-catalogue-current)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

404 tools cover the entire External API surface — accounts, domains, DNS,
SSL, email, MySQL, FTP, security, backups, server resources, and more.

---

## Table of Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
  - [Option A — npm (recommended)](#option-a--npm-recommended)
  - [Option B — Docker](#option-b--docker)
  - [Option C — Build from source](#option-c--build-from-source)
- [Configuration](#configuration)
  - [1. Open the External API port](#1-open-the-external-api-port)
  - [2. Generate an API key in the panel](#2-generate-an-api-key-in-the-panel)
  - [3. Verify the credentials with curl](#3-verify-the-credentials-with-curl)
- [Wire it into your MCP client](#wire-it-into-your-mcp-client)
  - [Claude Code (one command)](#claude-code-one-command)
  - [Claude Desktop](#claude-desktop)
  - [Cursor](#cursor)
  - [OpenAI Codex CLI](#openai-codex-cli)
  - [Continue.dev, Cline, Zed](#continuedev-cline-zed)
  - [Generic stdio client](#generic-stdio-client)
- [Tool catalogue](#tool-catalogue)
- [Example sessions](#example-sessions)
- [Permission scopes](#permission-scopes)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Versioning & support](#versioning--support)
- [License](#license)

---

## How it works

```
+----------------+         stdio JSON-RPC          +-------------------+
|  MCP client    |  <----------------------------> |  panelica-mcp     |
|  (Claude, ...) |                                 |  (this package)   |
+----------------+                                 +---------+---------+
                                                             |
                                          HTTPS + HMAC-SHA256|
                                            X-API-Key        |
                                            X-Timestamp      |
                                            X-Signature      |
                                                             v
                              +------------------------------+------------------------------+
                              |  https://<panel-host>:8443/api/external/v1/...               |
                              |  nginx reverse proxy on the panel host                       |
                              |  (TLS termination + path rewrite: /api/external/X -> /X)     |
                              +------------------------------+------------------------------+
                                                             |
                                       127.0.0.1:3002 plain  |
                                                             v
                                            +----------------+-----------------+
                                            |  external-server (HMAC verify)   |
                                            +----------------+-----------------+
                                                             |
                                                             v
                                            +----------------+-----------------+
                                            |  Panelica panel + Linux services |
                                            +----------------------------------+
```

`panelica-mcp` is a thin, stateless adapter:

1. The MCP client launches the binary over stdio.
2. At startup the server fetches `<PANELICA_BASE_URL>/v1/api-spec` from **your**
   panel and builds the tool list from it (live catalogue, default). If the panel
   is unreachable it falls back to the bundled `tools/tools.json` snapshot. Set
   `PANELICA_LIVE_SPEC=0` to always use the snapshot.
3. The client asks for the tool list and receives it — together with **server
   instructions** (how ids, scopes, response envelopes, errors and rate limits
   work, plus workflow recipes), generated from that same catalogue. See
   [What the assistant knows](#what-the-assistant-knows).
4. When the client calls a tool, the server builds the corresponding HTTP
   request, signs it with HMAC-SHA256 using your local `PANELICA_API_SECRET`,
   and forwards it to the panel.
5. The HTTP response is returned to the client as the tool result. A failed
   call comes back as an explanation of what to do next (missing scope, wrong
   id, rate-limit reset…) rather than a bare status code.

No data is cached, no telemetry is emitted, and the secret never leaves the
machine running the MCP server.

## Requirements

- A running Panelica panel (version 1.0.193 or newer recommended; the External
  API surface is stable from 1.0.180+).
- HTTPS access to the panel UI on port 8443 from the machine that will run
  `panelica-mcp`. This is the same port you already use in the browser — no
  extra firewall change is required.
- One of the following runtimes on that machine:
  - **Node.js ≥ 20** for the npm install path
  - **Docker** for the container path

You do **not** need to install anything on the panel host itself, and you do
**not** need to open the internal port 3002 to the public internet.

## Install

Pick whichever fits your MCP client setup. All three produce the same stdio
binary; pick by which sandbox model you prefer.

### Option A — npm (recommended)

```bash
npm install -g panelica-mcp
```

or run without installing (the MCP client launches `npx` for you):

```bash
npx -y panelica-mcp
```

The `-y` flag accepts npm's "install on first run" prompt non-interactively,
which is what MCP clients need.

### Option B — Docker

A pre-built image is published to GitHub Container Registry on every release:

```bash
docker pull ghcr.io/panelica/panelica-mcp:latest
```

Run it from an MCP client config:

```json
{
  "command": "docker",
  "args": [
    "run", "--rm", "-i",
    "-e", "PANELICA_BASE_URL",
    "-e", "PANELICA_API_KEY",
    "-e", "PANELICA_API_SECRET",
    "ghcr.io/panelica/panelica-mcp:latest"
  ],
  "env": {
    "PANELICA_BASE_URL": "https://your-panel-host:8443/api/external",
    "PANELICA_API_KEY":  "pk_...",
    "PANELICA_API_SECRET": "sk_..."
  }
}
```

`-i` keeps stdin attached so the MCP client can talk to the container.
`--rm` removes the container when the client disconnects.

### Option C — Build from source

```bash
git clone https://github.com/Panelica/panelica-mcp.git
cd panelica-mcp
npm install
npm run build
node dist/index.js          # speaks MCP over stdio
```

To regenerate `tools/tools.json` from your panel's live API spec:

```bash
PANELICA_SPEC_URL="https://your-panel:8443/api/external/v1/api-spec" npm run rebuild-tools
```

## Configuration

You need three values: a reachable base URL, an API key, and an API secret.

### 1. Pick the right base URL

Panelica's `external-server` process listens on `127.0.0.1:3002`, and the
panel's nginx on **8443** reverse-proxies `/api/external/...` to it. Nginx
strips the `/api/external` prefix before forwarding, so the path the HMAC
signature is computed over and the path the backend sees both end up as
`/v1/...` — signatures match end-to-end without any extra knobs.

The right `PANELICA_BASE_URL` depends on where you run `panelica-mcp`:

| Scenario | Recommended `PANELICA_BASE_URL` |
|---|---|
| MCP client on your laptop, panel on a remote server | `https://<panel-host>:8443/api/external` |
| MCP client and panel on the **same** machine | `http://127.0.0.1:3002` |

You should **not** open port 3002 to the public internet. The default install
binds it on all interfaces but expects it to be either firewalled or only
reached through the 8443 reverse proxy.

Sanity-check the proxy from your machine:

```bash
curl -sk https://<panel-host>:8443/api/external/health
# {"status":"ok"} or similar
```

If you get a TLS error, that is the panel's self-signed certificate — install
a real cert on the panel (panel UI → Settings → SSL) rather than disabling
verification client-side.

### 2. Generate an API key in the panel

1. Sign in to the panel as **root** or any account with permission to manage
   API keys.
2. Navigate to **Settings → API Keys → Generate API Key**.
3. Pick the scopes you want the MCP server to have. For a read-only assistant,
   `*:read` is enough (panel 1.0.528+; older panels need the individual
   `<area>:read` scopes). For full automation grant `*:write` and `*:delete`
   too, or `*:*`. Every tool's `description` in this server lists the scopes it
   requires.
4. Copy both **key** (looks like `pk_...`) and **secret** (looks like `sk_...`).
   The secret is shown **only once**; store it in a password manager.

### 3. Verify the credentials with curl

Before you wire the MCP client up, prove the credentials work end-to-end:

```bash
export PANELICA_BASE_URL=https://your-panel-host:8443/api/external
export PANELICA_API_KEY=pk_xxxxxxxx
export PANELICA_API_SECRET=sk_xxxxxxxx

TS=$(date +%s)
# Signature is over METHOD + PATH + TIMESTAMP + BODY. The path is the
# backend-visible path (/v1/...) — NOT the /api/external/ prefix that nginx
# strips before forwarding. panelica-mcp does this automatically.
SIG=$(printf "GET/v1/api-keys${TS}" \
  | openssl dgst -sha256 -hmac "$PANELICA_API_SECRET" -hex | awk '{print $2}')

curl -sk "$PANELICA_BASE_URL/v1/api-keys" \
  -H "X-API-Key:   $PANELICA_API_KEY" \
  -H "X-Timestamp: $TS" \
  -H "X-Signature: $SIG"
```

You should get back JSON listing your API keys. Common 401 responses:

| `error.code` | Likely cause |
|---|---|
| `MISSING_API_KEY` / `MISSING_TIMESTAMP` / `MISSING_SIGNATURE` | Header is empty — re-check the curl flags |
| `INVALID_KEY_FORMAT` | The `PANELICA_API_KEY` value is malformed |
| `INVALID_TIMESTAMP` | Local clock drifted more than 5 minutes — sync NTP |
| `INVALID_SIGNATURE` | Wrong secret, **or** the path you signed includes `/api/external/` (it must not — nginx strips it before the backend sees it) |

### 4. Optional environment variables

| Variable | Default | Effect |
|---|---|---|
| `PANELICA_TOOLSETS` | `core` | Which tools are registered directly — see [Toolsets](#toolsets--what-the-client-sees) |
| `PANELICA_LIVE_SPEC` | `1` | Build the catalogue from your panel's `/v1/api-spec` at startup; `0` = bundled snapshot only |
| `PANELICA_SPEC_TIMEOUT_MS` | `8000` | Live-spec fetch timeout before falling back to the snapshot |
| `PANELICA_TIMEOUT_MS` | `30000` | Per-call HTTP timeout |
| `PANELICA_MAX_RESULT_CHARS` | `60000` | Larger list results are cut to the first items with a `_truncated` note so the client context is not flooded |
| `PANELICA_STARTUP_PROBE` | `1` | Call `GET /v1/me` once at startup to state the key's scopes in the instructions; `0` skips it |

## Wire it into your MCP client

### Claude Code (one command)

```bash
claude mcp add panelica \
  -e PANELICA_BASE_URL=https://your-panel:8443/api/external \
  -e PANELICA_API_KEY=pk_... \
  -e PANELICA_API_SECRET=sk_... \
  -- npx -y panelica-mcp
```

That's it — ask Claude Code to "list my domains" or "create a database for
example.com" and it will drive the panel through the scoped API key.

### Claude Desktop

Edit your Claude Desktop config:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux (Claude Desktop beta):** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "panelica": {
      "command": "npx",
      "args": ["-y", "panelica-mcp"],
      "env": {
        "PANELICA_BASE_URL":   "https://your-panel-host:8443/api/external",
        "PANELICA_API_KEY":    "pk_...",
        "PANELICA_API_SECRET": "sk_..."
      }
    }
  }
}
```

Save, fully quit Claude Desktop (not just close the window — *Quit*), and
re-open it. A new chat will show `panelica` as a connected MCP server with
"404 tools available" (the core set plus three meta tools; set `PANELICA_TOOLSETS=all` for all 404).

### Cursor

In **Settings → MCP → Add new server**:

```json
{
  "panelica": {
    "command": "npx",
    "args": ["-y", "panelica-mcp"],
    "env": {
      "PANELICA_BASE_URL":   "https://your-panel-host:8443/api/external",
      "PANELICA_API_KEY":    "pk_...",
      "PANELICA_API_SECRET": "sk_..."
    }
  }
}
```

### OpenAI Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.panelica]
command = "npx"
args = ["-y", "panelica-mcp"]

[mcp_servers.panelica.env]
PANELICA_BASE_URL = "https://your-panel:8443/api/external"
PANELICA_API_KEY = "pk_..."
PANELICA_API_SECRET = "sk_..."
```

### Continue.dev, Cline, Zed

Any MCP-aware editor that accepts a stdio command works the same way — give it
`npx -y panelica-mcp` (or the absolute path to the built `dist/index.js`) and
the three environment variables.

### Generic stdio client

```bash
PANELICA_BASE_URL=https://your-panel-host:8443/api/external \
PANELICA_API_KEY=pk_... \
PANELICA_API_SECRET=sk_... \
panelica-mcp
```

The process speaks MCP JSON-RPC over stdin/stdout. Send an `initialize`
request first, then `tools/list`, then `tools/call`.

## Toolsets — what the client sees

MCP clients budget tools: Cursor caps active tools at about 40 across all
servers and silently drops the rest, and every registered tool costs prompt
tokens on each turn. So by default the server registers a compact **core** set
(34 everyday tools: accounts, domains, DNS, SSL, databases, e-mail, FTP,
backups, server status/services, WordPress, Docker, plans) plus three meta
tools that reach the whole catalogue:

| Tool | What it does |
|---|---|
| `panelica_find_tools` | Keyword search over every catalogue tool; returns names, HTTP route, parameters, body fields and what each returns |
| `panelica_describe_tool` | One tool in full: every parameter with its provenance, body fields (type, required), the response envelope and its data fields |
| `panelica_call` | Runs any catalogue tool by name with its arguments (same scoped, HMAC-signed client) |

Choose the set with `PANELICA_TOOLSETS` (comma-separated, unioned):

| Value | Registered tools |
|---|---|
| `core` (default) | 34 + 3 meta |
| `all` | every catalogue tool + 3 meta (the pre-0.3 behaviour; fine for Claude Code / Claude Desktop) |
| `none` | only the 3 meta tools |
| category slugs, e.g. `domains,dns,ssl,git,docker,file_manager,laravel_apps,node_js_apps,python_apps,logs` | those categories (+ `core` if listed) |

Direct calls to a non-registered catalogue tool are still accepted, so a
client that learned a tool name from `panelica_find_tools` can call it either
way.

## What the assistant knows

An assistant that only sees 400 tool names guesses ids, retries 403s and
misreads responses. `panelica-mcp` gives it the API "by heart" instead, and
everything below is generated from the catalogue, so it can never promise a
path the panel does not have:

- **Server instructions** (sent on `initialize`, so every client injects them
  into the model's context): how calls work, that every id is a UUID coming
  from a list call, that users are called *accounts*, the
  `{"status":"success","data":…}` envelope, unpaginated lists, what each error
  class means and what to do, scope families, the category map with counts,
  safety rules for mutating/destructive tools, and workflow recipes that are
  included only when every step exists in the catalogue.
- **Your key, up front.** At startup the server calls `GET /v1/me` once and
  tells the model which key it holds, its scopes, tier and expiry — so a
  read-only key is announced as read-only and out-of-scope tools are declined
  with the scope to add, not attempted. A rejected credential is reported in
  the instructions before the first tool call. (`PANELICA_STARTUP_PROBE=0`
  disables the probe.)
- **Scopes as the code enforces them.** Newer panels derive the required scopes
  from the middleware chain instead of hand-written docs, including "one of a,
  b" rules and role restrictions (ROOT/ADMIN); the tool description repeats
  them verbatim.
- **Allowed values.** Fields with a declared value list (`ssl_provider`,
  `web_server`, `restart_policy` …) carry a JSON-schema `enum` and `default`,
  so the model does not guess.
- **Big lists stay usable.** Every list-returning GET accepts `_limit`,
  `_fields` and `_match`; the server applies them to the response (the panel
  never sees them) and reports `{total, matched, shown}` so a 500-domain panel
  can be searched in one call.
- **Validation errors name the field.** A Gin validation failure becomes
  `field "user_id" is required` / `field "type" must be one of the allowed
  values` using the JSON names the model used.
- **Search speaks the user's language.** `panelica_find_tools` maps
  website→domain, certificate→ssl, mailbox→email, container→docker and stems
  plurals, so the first query finds the right tool.
- **Transient limits are absorbed.** A 429 whose window resets within 15 s is
  waited out once; a GET that fails on the network is retried once; a clock
  skew above two minutes against the panel is flagged in the instructions
  (HMAC timestamps would be rejected).
- **Per-tool descriptions** carry the HTTP route, required scopes, a
  `Returns:` line with the response envelope and the first data fields, and the
  risk class (read-only / mutating / destructive).
- **Id parameters say where they come from** — `UUID of the domain — obtain
  it from GET /v1/domains` — for path, query and body fields alike. Newer
  panels ship this in the spec; for older panels the server derives it.
- **`panelica_describe_tool`** returns the exact parameters, body fields and
  response fields of one tool, so the model checks before it calls.
- **Errors are explained, not echoed**: a 403 names the missing scope and says
  retrying cannot help; a 404 says to re-list and use a real id; a 429 reports
  the reset window; 5xx says to report, not loop. The raw panel response is
  appended for reference.
- **Results are bounded**: oversized list responses are cut to the first items
  with an explicit `_truncated` note (still valid JSON) instead of flooding the
  context.
- **Resources** for clients that support them: `panelica://guide` (the
  instructions), `panelica://catalogue` (every tool with route and summary) and,
  in live mode, `panelica://spec` (your panel's full API spec).

The response-field lists come from the panel's `/v1/api-spec`, which newer
panels derive from their handler source at build time; a panel that predates
this still works — its tools simply show `{status, data}` without field names.

## Tool catalogue

**404 tools** are auto-generated from the panel's live `/v1/api-spec`, so they never
drift from the API. Each tool carries MCP safety annotations
(![read-only](https://img.shields.io/badge/-read--only-brightgreen) 181 ·
![mutating](https://img.shields.io/badge/-mutating-orange) 177 ·
![destructive](https://img.shields.io/badge/-destructive-red) 46)
that capable clients use to auto-approve reads and warn before destructive calls.
Body fields and query parameters are derived from the panel's handler code
(`gen-external-schemas` in the panel repository), so on panels from 1.0.528 on
mutating tools carry typed, required-marked bodies and action endpoints such as
`…/suspend` or `…/restart` declare that they take no body at all.

| Category | Tools |
|----------|------:|
| Git | 43 |
| Domains | 32 |
| Logs | 26 |
| File Manager | 23 |
| Laravel Apps | 21 |
| Python Apps | 19 |
| Node.js Apps | 18 |
| Accounts | 16 |
| CloudFlare | 12 |
| Docker | 12 |
| IP Addresses | 9 |
| Cron Jobs | 8 |
| Email | 8 |
| FTP | 8 |
| Security | 8 |
| Databases | 7 |
| Spam | 7 |
| SSH Users | 7 |
| WordPress | 7 |
| API Keys | 6 |
| License | 6 |
| MySQL Users | 6 |
| Server | 6 |
| Webhooks | 6 |
| Backups | 5 |
| DNS | 5 |
| Migrations | 5 |
| Plans | 5 |
| Snapshots | 5 |
| 2FA | 4 |
| Antivirus | 4 |
| Backup Schedules | 4 |
| Mailing Lists | 4 |
| SSL | 4 |
| Bandwidth | 3 |
| Config Locks | 3 |
| Core | 3 |
| Remote MySQL | 3 |
| Sessions | 3 |
| Subdomains | 3 |
| Terminal | 3 |
| Audit | 2 |
| Metrics | 2 |
| Notifications | 2 |
| Panel Settings | 2 |
| Resource Quota | 2 |
| SMTP Relay | 2 |
| System Cron | 2 |
| Mail Queue | 1 |
| PHP | 1 |
| Redirects | 1 |

Full machine-readable list: [`tools/tools.json`](tools/tools.json).

## Example sessions

After wiring the server up, try these in your MCP client:

**Domain provisioning.**
> *"Create a new account for `alice@example.com` on the `starter` plan, then
> add the domain `alice-shop.com` to it and issue a Let's Encrypt
> certificate."*

The assistant will pick up `panelica_accounts_post_v1_accounts`,
`panelica_domains_post_v1_domains`, and `panelica_ssl_post_v1_ssl_...` from
the catalogue, fill in the parameters from the conversation, and call them in
sequence. You can watch the calls happen in the client's tool log.

**Diagnostic.**
> *"Show me the last 24 hours of bandwidth usage for `alice-shop.com` and tell
> me whether it is on track to exceed the plan quota this month."*

**Bulk cleanup.**
> *"List every domain whose SSL certificate expires in the next 14 days and
> renew them all."*

**DNS migration.**
> *"For the zone `alice-shop.com`, list the current A and CNAME records, then
> add `www` as a CNAME to `alice-shop.com` and an A record for `mail`
> pointing to `203.0.113.10`."*

The assistant will only invoke tools whose scopes are granted to your API
key, so a read-only key safely answers "list" questions but refuses
"create / delete".

## Permission scopes

API keys are scoped — grant an AI assistant exactly the access it needs, nothing
more. **No scope is preselected** when creating a key in the panel, and the
create dialog has live search over all 50 scopes.
![read](https://img.shields.io/badge/-read-brightgreen) view/list only · ![write](https://img.shields.io/badge/-write-orange) create/update · ![delete](https://img.shields.io/badge/-delete-red) remove · ![special](https://img.shields.io/badge/-special-blue) special access.
Every family also accepts its wildcard (`domains:*`) and `*:*` grants everything.

| Area | Scopes |
|------|--------|
| Accounts | `accounts:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `accounts:write` ![write](https://img.shields.io/badge/-write-orange) · `accounts:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| Domains & subdomains | `domains:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `domains:write` ![write](https://img.shields.io/badge/-write-orange) · `domains:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| Databases | `databases:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `databases:write` ![write](https://img.shields.io/badge/-write-orange) · `databases:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| DNS | `dns:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `dns:write` ![write](https://img.shields.io/badge/-write-orange) · `dns:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| Email | `email:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `email:write` ![write](https://img.shields.io/badge/-write-orange) · `email:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| FTP | `ftp:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `ftp:write` ![write](https://img.shields.io/badge/-write-orange) · `ftp:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| SSL | `ssl:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `ssl:write` ![write](https://img.shields.io/badge/-write-orange) |
| Backups & snapshots | `backups:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `backups:write` ![write](https://img.shields.io/badge/-write-orange) · `backups:restore` ![special](https://img.shields.io/badge/-special-blue) |
| File Manager | `files:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `files:write` ![write](https://img.shields.io/badge/-write-orange) · `files:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| CloudFlare | `cloudflare:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `cloudflare:write` ![write](https://img.shields.io/badge/-write-orange) · `cloudflare:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| Docker & app templates | `docker:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `docker:write` ![write](https://img.shields.io/badge/-write-orange) · `docker:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| App hosting (Laravel / Node.js / Python) | `apps:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `apps:write` ![write](https://img.shields.io/badge/-write-orange) · `apps:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| Git & Deploy | `git:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `git:write` ![write](https://img.shields.io/badge/-write-orange) · `git:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| Logs & audit | `logs:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `logs:write` ![write](https://img.shields.io/badge/-write-orange) |
| Security (antivirus, firewall, IP blocks) | `security:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `security:write` ![write](https://img.shields.io/badge/-write-orange) · `security:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| Server & infrastructure | `server:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `server:write` ![write](https://img.shields.io/badge/-write-orange) |
| Service control | `services:restart` ![special](https://img.shields.io/badge/-special-blue) · `services:start` ![special](https://img.shields.io/badge/-special-blue) · `services:stop` ![special](https://img.shields.io/badge/-special-blue) |
| Plans | `plans:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `plans:write` ![write](https://img.shields.io/badge/-write-orange) |
| Webhooks | `webhooks:read` ![read](https://img.shields.io/badge/-read-brightgreen) · `webhooks:write` ![write](https://img.shields.io/badge/-write-orange) · `webhooks:delete` ![delete](https://img.shields.io/badge/-delete-red) |
| Bandwidth | `bandwidth:read` ![read](https://img.shields.io/badge/-read-brightgreen) |
| License | `license:read` ![read](https://img.shields.io/badge/-read-brightgreen) |
| Migrations (panel-to-panel) | `migrations:read` ![read](https://img.shields.io/badge/-read-brightgreen) |
| Terminal | `terminal:access` ![special](https://img.shields.io/badge/-special-blue) |
| Full access | `*:*` ![special](https://img.shields.io/badge/-special-blue) |

Mutating service control deliberately requires its own action scopes (or
`server:write`) — a metrics-only `server:read` key can **not** stop MySQL.

## Rate limits

API keys carry a rate-limit tier (`rate_limit_tier` when creating the key:
`starter` 60/min, `professional` 300/min, `business` 1000/min, `enterprise`
unlimited). The default `starter` tier is easy to exhaust when an assistant
fans out many calls; create the assistant's key with a higher tier if you see
`429 RATE_LIMIT_EXCEEDED` (the response carries `reset_at`).

## Security model

- **HMAC-SHA256 request signing.** Every request is signed over
  `METHOD + PATH + QUERY + TIMESTAMP + BODY` with your API secret. The panel
  rejects requests whose timestamp drifts more than 5 minutes from server
  clock, so replays are not possible.
- **Secrets stay local.** The API secret is read from the process environment
  and used only to compute the signature. It is never logged, sent to any
  third party, or written to disk.
- **Scope-restricted keys.** Generate one API key per use case. Grant only
  the scopes that use case needs — e.g. `domains:read` for a read-only
  assistant, `*:write` only for full automation.
- **Audit trail.** Every request hits the panel's normal audit logging and
  RBAC. Actions taken via MCP are indistinguishable from any other
  authenticated API call and can be traced to the API key that performed
  them.
- **No data harvesting.** This server emits no telemetry, writes no cache,
  and contacts no third party.
- **Container hardening.** The Docker image runs as a non-root user and
  exposes no ports — it speaks only stdio.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Client reports "404 tools available" | Server crashed at startup — usually a missing env var | Run `panelica-mcp` once from a shell with the three env vars set; read stderr |
| `401 MISSING_API_KEY` | `PANELICA_API_KEY` not set or wrong header passthrough | Re-check the MCP client config; restart the client after editing |
| `401 INVALID_SIGNATURE` | Wrong `PANELICA_API_SECRET`, or clock drift > 5 min | `chronyc tracking` (or `timedatectl status`) on both the MCP host and panel host |
| `401 INVALID_TIMESTAMP` | Local clock drift > 5 min | Sync NTP on the MCP host |
| Connect timeout on `BASE_URL` | Wrong host/port — typically `:8443/api/external` was missed off the URL | Verify with `curl -sk $PANELICA_BASE_URL/health` — should return `{"status":"ok"}` |
| Tool result starts with `Panelica API error 403` and names a scope | API key lacks that scope | Add the scope to the key in the panel (Settings → API Keys); the assistant is told not to retry |
| Tool result says `Panelica API error 404 … re-list` | The assistant used an id that does not exist for this key's owner | Nothing to fix server-side; the guidance makes it list again and pick a real id |
| Tool description says "Schema not statically declared" | The endpoint binds a dynamic request body (map / multipart) | Pass a free-form `body` object; the panel validates and answers 400 with the missing field, which the assistant is told to read |
| Startup log says `clock skew of Ns versus the panel` | The MCP host's clock is off | Sync NTP on the MCP host; signed requests carry a timestamp the panel checks |
| Startup log says `startup credential check failed` | Key/secret rejected by `GET /v1/me` | The instructions already tell the assistant; fix the key in the panel and restart the client |
| TLS verification fails | Panel is using its self-signed cert | If the MCP host trusts that CA, this works out of the box. If not, deploy a real cert on the panel (panel UI → Settings → SSL) — do not disable TLS verification client-side |

If you are still stuck, open an issue at
[github.com/Panelica/panelica-mcp/issues](https://github.com/Panelica/panelica-mcp/issues)
with the (redacted) stderr output.

## Development

```bash
git clone https://github.com/Panelica/panelica-mcp.git
cd panelica-mcp
npm install
npm run build
node dist/index.js
```

Project layout:

```
.
├── src/index.ts          # MCP server (stdio transport, HMAC client, live-spec loader)
├── src/catalog.ts        # spec → tools generator (shared by runtime and build script)
├── src/toolsets.ts       # core set, PANELICA_TOOLSETS selection, find/describe/call meta tools
├── src/instructions.ts   # server instructions generated from the catalogue
├── src/errors.ts         # error explanations + result bounding
├── tools/
│   ├── build-tools.mjs   # Generates tools.json from the API spec
│   ├── api-spec.json     # Committed snapshot of the live /v1/api-spec
│   └── tools.json        # tool definitions, auto-generated (committed)
├── .github/workflows/
│   └── refresh-tools.yml # Weekly CI: regenerate, bump, tag, publish npm + Docker + Registry
├── Dockerfile
├── smithery.yaml         # Smithery deployment manifest
├── .env.example
└── README.md
```

### Keeping the tool catalogue current

The catalogue never drifts from the API by hand. The backend serves an
always-current `/v1/api-spec` (built from its route registry), and the tools are
regenerated from it:

```bash
# Rebuild from the committed snapshot (offline):
npm run rebuild-tools

# Pull the live spec, refresh the snapshot, and rebuild:
PANELICA_SPEC_URL="https://your-panel:8443/api/external/v1/api-spec" npm run rebuild-tools
```

CI (`refresh-tools.yml`) runs this weekly against the panel named in the
`PANELICA_SPEC_URL` repository **secret**. When the catalogue changed it bumps the
patch version, tags, and publishes npm, the Docker image and the MCP Registry
entry in the same run, so a new API endpoint reaches `npx -y panelica-mcp`
users automatically. Running servers do not even need that: with the default
live catalogue they read the spec from the panel they talk to. Each tool is tagged with safety
annotations (`readOnlyHint` for `GET`, `destructiveHint` for `DELETE`) that
capable MCP clients use to auto-approve reads and warn before destructive calls.

A separate, internal dataset of every panel endpoint (1,263 total) exists for
training purposes — only the **404 documented External API endpoints** are
exposed through this package. Internal panel endpoints, recorded DEV data,
and training jsonl files are not part of the public repository.

## Versioning & support

- This package follows the Panelica panel's External API. Tool signatures
  change only when the panel itself ships a backward-incompatible API change,
  and the package's major version is bumped to match.
- New endpoints become available the next time we regenerate
  `tools/tools.json` and publish a release — or immediately, in live mode,
  from your own panel's `/v1/api-spec`.
- Response-field lists, id provenance and cleaned descriptions come from the
  panel's spec; a panel that predates them still works with plainer tools.
- Panel issues (the API itself, not this client): the Panelica forum at
  [forum.panelica.com](https://forum.panelica.com).
- Client / packaging issues:
  [github.com/Panelica/panelica-mcp/issues](https://github.com/Panelica/panelica-mcp/issues).

## License

MIT. See [LICENSE](LICENSE).

## Links

- Panel website: <https://panelica.com>
- Live demo: <https://demo.panelica.com>
- Documentation: <https://panelica.com/docs>
- Forum & support: <https://forum.panelica.com>
- Public installer: <https://latest.panelica.com/install.sh>
