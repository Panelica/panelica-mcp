# Panelica MCP Server

> Talk to your [Panelica](https://panelica.com) hosting panel in plain English.
> Provision a domain, issue an SSL certificate, create a database, or restart a
> service through Claude Desktop, Cursor, ChatGPT, or any other
> [Model Context Protocol](https://modelcontextprotocol.io) client.

198 tools cover the entire External API surface — accounts, domains, DNS,
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
  - [Claude Desktop](#claude-desktop)
  - [Cursor](#cursor)
  - [Continue.dev, Cline, Zed](#continuedev-cline-zed)
  - [Smithery (one-click hosted install)](#smithery-one-click-hosted-install)
  - [Generic stdio client](#generic-stdio-client)
- [Tool catalogue](#tool-catalogue)
- [Example sessions](#example-sessions)
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
                                        +--------------------+--------------------+
                                        |  Panelica External API  (port 3002)    |
                                        |  external-server process               |
                                        +----------------------+-----------------+
                                                               |
                                                               v
                                            +------------------+-----------------+
                                            |  Panelica panel + Linux services   |
                                            +------------------------------------+
```

`panelica-mcp` is a thin, stateless adapter:

1. The MCP client launches the binary over stdio.
2. The client asks for the tool list — the server reads `tools/tools.json`
   (198 entries, generated from the panel's own API metadata) and returns it.
3. When the client calls a tool, the server builds the corresponding HTTP
   request, signs it with HMAC-SHA256 using your local `PANELICA_API_SECRET`,
   and forwards it to the panel.
4. The HTTP response is returned to the client as the tool result.

No data is cached, no telemetry is emitted, and the secret never leaves the
machine running the MCP server.

## Requirements

- A running Panelica panel (version 1.0.193 or newer recommended; the External
  API surface is stable from 1.0.180+).
- Network reachability from the machine running `panelica-mcp` to your panel's
  External API port (default 3002 — see [configuration](#1-open-the-external-api-port)
  below).
- One of the following runtimes on the machine that hosts `panelica-mcp`:
  - **Node.js ≥ 20** for the npm install path
  - **Docker** for the container path

You do **not** need to install anything on the panel host itself.

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
    "PANELICA_BASE_URL": "https://your-panel-host:3002",
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

To regenerate `tools/tools.json` from a fresh API dataset:

```bash
PANELICA_DATASET=/path/to/panelica-api-complete.jsonl npm run rebuild-tools
```

## Configuration

You need three values: a reachable base URL, an API key, and an API secret.

### 1. Open the External API port

Panelica's `external-server` process listens on **TCP 3002** by default. The
panel's reverse proxy on port 8443 does **not** transparently forward HMAC
requests — its path rewrite invalidates the signature — so the MCP server must
talk to 3002 directly.

On the panel host:

```bash
# Verify external-server is up
/opt/panelica/bin/pn-service status external-server

# Allow inbound 3002 from the host that will run panelica-mcp.
# Replace <mcp-host-ip>/32 with the public IP of that machine.
sudo nft add rule inet panelica input ip saddr <mcp-host-ip>/32 tcp dport 3002 accept
```

> Do not open 3002 to `0.0.0.0/0`. HMAC stops replay and forgery, but exposing
> the port to the public internet is unnecessary attack surface. Whitelist
> only the MCP host (or the LAN it sits in).

If the MCP host and the panel host are the same machine, no firewall change
is required — set `PANELICA_BASE_URL=http://127.0.0.1:3002`.

### 2. Generate an API key in the panel

1. Sign in to the panel as **root** or any account with permission to manage
   API keys.
2. Navigate to **Settings → API Keys → Generate API Key**.
3. Pick the scopes you want the MCP server to have. For a read-only assistant,
   `*:read` is enough. For full automation, grant `*:write` too. Every tool's
   `description` in this server lists the scopes it requires.
4. Copy both **key** (looks like `pk_...`) and **secret** (looks like `sk_...`).
   The secret is shown **only once**; store it in a password manager.

### 3. Verify the credentials with curl

Before you wire the MCP client up, prove the credentials work:

```bash
TS=$(date +%s)
SIG=$(printf "GET/v1/accounts/me${TS}" | \
      openssl dgst -sha256 -hmac "$PANELICA_API_SECRET" -hex | awk '{print $2}')

curl -sk "$PANELICA_BASE_URL/v1/accounts/me" \
  -H "X-API-Key:    $PANELICA_API_KEY" \
  -H "X-Timestamp:  $TS" \
  -H "X-Signature:  $SIG"
```

You should get back a JSON document describing your panel account. If you
get `401 INVALID_SIGNATURE`, the secret is wrong or the system clock has
drifted more than 5 minutes from the panel host.

## Wire it into your MCP client

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
        "PANELICA_BASE_URL":   "https://your-panel-host:3002",
        "PANELICA_API_KEY":    "pk_...",
        "PANELICA_API_SECRET": "sk_..."
      }
    }
  }
}
```

Save, fully quit Claude Desktop (not just close the window — *Quit*), and
re-open it. A new chat will show `panelica` as a connected MCP server with
"198 tools available".

### Cursor

In **Settings → MCP → Add new server**:

```json
{
  "panelica": {
    "command": "npx",
    "args": ["-y", "panelica-mcp"],
    "env": {
      "PANELICA_BASE_URL":   "https://your-panel-host:3002",
      "PANELICA_API_KEY":    "pk_...",
      "PANELICA_API_SECRET": "sk_..."
    }
  }
}
```

### Continue.dev, Cline, Zed

Any MCP-aware editor that accepts a stdio command works the same way — give it
`npx -y panelica-mcp` (or the absolute path to the built `dist/index.js`) and
the three environment variables.

### Smithery (one-click hosted install)

If you do not want to manage the process yourself, install the server through
[Smithery](https://smithery.ai/server/Panelica/panelica-mcp). Smithery prompts
you for the three configuration values and runs the server in its hosted
sandbox.

### Generic stdio client

```bash
PANELICA_BASE_URL=https://your-panel-host:3002 \
PANELICA_API_KEY=pk_... \
PANELICA_API_SECRET=sk_... \
panelica-mcp
```

The process speaks MCP JSON-RPC over stdin/stdout. Send an `initialize`
request first, then `tools/list`, then `tools/call`.

## Tool catalogue

198 tools are generated from the panel's own API metadata. Categories:

| Category | Tools | What you can do |
|----------|------:|------------------|
| File Manager | 19 | Browse, upload, download, edit, rename, compress |
| Domains | 19 | Create, suspend, transfer, delete, list subdomains |
| CloudFlare | 12 | Zone CRUD, DNS sync, cache purge |
| Accounts | 12 | Create users, change passwords, suspend, list |
| Email | 10 | Mailboxes, forwarders, mailing lists, DKIM/SPF |
| Spam | 7 | Filter configuration, training |
| Security | 7 | Firewall, IP block, mod_security, audit |
| IP Addresses | 7 | Assign, release, list |
| Server | 6 | Resource metrics, snapshots |
| License | 6 | View, transfer |
| FTP | 6 | Accounts, quotas |
| Cron Jobs | 6 | Create, list, delete |
| SSH Users | 5 | Create, rotate keys, suspend |
| DNS | 5 | Zone records (A, AAAA, CNAME, MX, TXT, SRV, CAA) |
| DKIM/SPF | 5 | Generate, verify |
| Webhooks | 4 | Register, list, test |
| SSL | 4 | Let's Encrypt, custom certs, revoke |
| MySQL Users | 4 | Create, grant, drop |
| Databases | 4 | Create, list, drop, dump |
| API Keys | 4 | Manage MCP credentials themselves |
| Antivirus | 4 | Scan, quarantine, definitions |
| 2FA | 4 | Enable, disable, status, backup codes |
| Snapshots | 3 | Create, restore, list |
| Redirects | 3 | URL redirects |
| Plans | 3 | Hosting plan CRUD |
| Bandwidth | 3 | Quotas, usage |
| Backups | 3 | Schedule, list, restore |
| Sessions | 2 | Active sessions |
| Panel Settings | 2 | Branding, defaults |
| Notifications | 2 | Channels, history |
| Mailing Lists | 2 | Member management |
| Backup Schedules | 2 | Cron-based backup config |
| (others) | 12 | Audit, metrics, mail queue, migrations, etc. |

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
| Client reports "0 tools available" | Server crashed at startup — usually a missing env var | Run `panelica-mcp` once from a shell with the three env vars set; read stderr |
| `401 MISSING_API_KEY` | `PANELICA_API_KEY` not set or wrong header passthrough | Re-check the MCP client config; restart the client after editing |
| `401 INVALID_SIGNATURE` | Wrong `PANELICA_API_SECRET`, or clock drift > 5 min | `chronyc tracking` (or `timedatectl status`) on both the MCP host and panel host |
| `401 INVALID_TIMESTAMP` | Local clock drift > 5 min | Sync NTP on the MCP host |
| Connect timeout on `BASE_URL` | Firewall on panel host is blocking 3002 | `sudo nft list ruleset \| grep 3002` on the panel host; whitelist the MCP host's IP |
| `403 FORBIDDEN` on a tool | API key lacks the required scope | Regenerate the key in the panel with the scope listed in the tool's description |
| Tool description says "Schema not statically extractable" | The endpoint uses dynamic request bodies | Pass a free-form `body` object; the panel will validate and tell you the missing fields with a 400 response |
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
├── src/index.ts          # MCP server (stdio transport, HMAC client)
├── tools/
│   ├── build-tools.mjs   # Generates tools.json from the API dataset
│   └── tools.json        # 198 redacted tool definitions (committed)
├── Dockerfile
├── smithery.yaml         # Smithery deployment manifest
├── .env.example
└── README.md
```

A separate, internal dataset of every panel endpoint (1,263 total) exists for
training purposes — only the **198 documented External API endpoints** are
exposed through this package. Internal panel endpoints, recorded DEV data,
and training jsonl files are not part of the public repository.

## Versioning & support

- This package follows the Panelica panel's External API. Tool signatures
  change only when the panel itself ships a backward-incompatible API change,
  and the package's major version is bumped to match.
- New endpoints become available the next time we regenerate
  `tools/tools.json` and publish a release.
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
- This server on Smithery: <https://smithery.ai/server/Panelica/panelica-mcp>
