# Panelica MCP Server

Manage your [Panelica](https://panelica.com) hosting panel through any
[Model Context Protocol](https://modelcontextprotocol.io) client — Claude
Desktop, Cursor, ChatGPT, and others. Spin up accounts, provision domains,
issue SSL certificates, configure DNS, run backups, or restart services with
natural language instead of clicking through 200+ panel screens.

The server exposes **198 endpoints** of Panelica's public External API as MCP
tools. Authentication is HMAC-SHA256 — every call is signed locally with your
API secret; the secret never leaves the machine running the MCP server.

## What you can do

A non-exhaustive sample of categories covered by the 198 tools:

| Domain | Examples |
|---|---|
| Accounts | create, suspend, change password, list, delete |
| Domains | create, suspend, transfer, list subdomains, delete |
| DNS | manage zones, records (A, AAAA, CNAME, MX, TXT, SRV, CAA) |
| SSL | request Let's Encrypt certificate, install custom cert, revoke |
| Email | mailboxes, forwarders, mailing lists, spam settings, DKIM/SPF |
| Databases | MySQL DBs and users, remote MySQL access |
| FTP / SSH | account create/update/delete, key management |
| Security | firewall, antivirus scan, quarantine, IP block, 2FA |
| Server | bandwidth, resource quotas, snapshots, backups, cron jobs |
| Cloudflare | zone management, DNS sync |
| Webhooks | register, list, test |

## Install

```bash
npm install -g panelica-mcp
```

Or run without installing:

```bash
npx -y panelica-mcp
```

## Configure

You need three values:

1. **`PANELICA_BASE_URL`** — the public URL of your panel's External API,
   typically `https://your-panel-host:3002`.
2. **`PANELICA_API_KEY`** — generated in the panel:
   *Settings → API Keys → Generate API Key*.
3. **`PANELICA_API_SECRET`** — shown only once at creation time. Store it in a
   password manager.

The API key needs scopes for the operations you intend to perform (each tool
description lists the scopes it requires).

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS
or `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "panelica": {
      "command": "npx",
      "args": ["-y", "panelica-mcp"],
      "env": {
        "PANELICA_BASE_URL": "https://your-panel-host:3002",
        "PANELICA_API_KEY": "pk_...",
        "PANELICA_API_SECRET": "sk_..."
      }
    }
  }
}
```

Restart Claude Desktop. Open a new chat and ask: *"List my domains."*

### Cursor

In Cursor settings → MCP servers:

```json
{
  "panelica": {
    "command": "npx",
    "args": ["-y", "panelica-mcp"],
    "env": {
      "PANELICA_BASE_URL": "https://your-panel-host:3002",
      "PANELICA_API_KEY": "pk_...",
      "PANELICA_API_SECRET": "sk_..."
    }
  }
}
```

### ChatGPT (custom GPT) / other MCP clients

Any client that speaks MCP over stdio can launch the server with:

```bash
PANELICA_BASE_URL=... PANELICA_API_KEY=... PANELICA_API_SECRET=... panelica-mcp
```

## Security model

- **HMAC-SHA256 request signing.** The signature covers
  `METHOD + PATH + QUERY + TIMESTAMP + BODY` and is rejected by the server if
  the timestamp drifts more than 5 minutes from server clock — replays are not
  possible.
- **Secrets stay local.** The API secret is read from your environment and
  used only to compute signatures. It is never sent to any third party or to
  Panelica itself; the panel verifies signatures using its own copy.
- **Scope-restricted keys.** When generating an API key in the panel, grant
  only the scopes you need (e.g. `domains:read` for a read-only AI assistant).
- **Audit trail.** Every request reaches the panel's normal RBAC and audit
  logging — actions taken via MCP are indistinguishable from any other
  authenticated API call.
- **No data harvesting.** This MCP server does not phone home, collect
  telemetry, or write to any disk except stdout/stderr.

## Build from source

```bash
git clone https://github.com/Panelica/panelica-mcp.git
cd panelica-mcp
npm install
npm run build
node dist/index.js   # speaks MCP over stdio
```

To regenerate the tool catalogue from a fresh API dataset:

```bash
PANELICA_DATASET=/path/to/panelica-api-complete.jsonl npm run rebuild-tools
```

## How the tool list was built

The 198 tools in `tools/tools.json` were generated from the Panelica project's
own API metadata dataset (1,263 endpoints; only the externally documented HMAC
surface is exposed here). The build script lives at
[`tools/build-tools.mjs`](tools/build-tools.mjs) and applies a redaction pass
to strip UUIDs, private IPs, email addresses, file paths, and stack traces
from any recorded examples before publication.

Internal panel endpoints, training data, and any DEV-environment artefacts are
**not** included in this repository.

## Versioning

The tool catalogue follows the Panelica panel's External API version. When
Panelica ships a new External API revision, this package is republished with
an updated `tools/tools.json` and an unchanged HMAC client. Existing API keys
continue to work without configuration changes.

## Contributing

Bug reports, missing-tool reports, and pull requests are welcome at
[github.com/Panelica/panelica-mcp](https://github.com/Panelica/panelica-mcp).

For panel-side issues (the API itself, not this client), use the Panelica
forum: [forum.panelica.com](https://forum.panelica.com).

## License

MIT. See [LICENSE](LICENSE).

## Links

- Panelica panel: <https://panelica.com>
- Live demo: <https://demo.panelica.com>
- Documentation: <https://panelica.com/docs>
- Forum & support: <https://forum.panelica.com>
- Public installer: <https://latest.panelica.com/install.sh>
