#!/usr/bin/env node
// Build tools/tools.json (the committed snapshot) from the Panelica External API spec.
//
// The generator itself lives in src/catalog.ts and is shared with the runtime
// (live-spec mode), so the snapshot and what a running server builds can never
// diverge. Run `npm run build` first; this wrapper imports dist/catalog.js.
//
// Source (in priority order):
//   1. $PANELICA_SPEC_URL  — fetch the live spec, redact it, refresh ./api-spec.json.
//                            The URL is never printed (CI keeps it in a secret).
//   2. ./api-spec.json      — committed snapshot (offline builds: npm/Smithery/CI).
//
// Output: ./tools.json  (one MCP tool per external endpoint)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const snapshotPath = resolve(__dirname, "api-spec.json");
const outputPath = resolve(__dirname, "tools.json");
const catalogPath = resolve(__dirname, "../dist/catalog.js");

if (!existsSync(catalogPath)) {
    console.error("dist/catalog.js not found — run `npm run build` first.");
    process.exit(2);
}
const { buildTools, fetchSpec, deepRedact } = await import(catalogPath);

async function loadSpec() {
    const url = process.env.PANELICA_SPEC_URL;
    if (url) {
        console.log("Fetching live spec from PANELICA_SPEC_URL");
        const raw = await fetchSpec(url, Number(process.env.PANELICA_SPEC_TIMEOUT_MS ?? 20_000));
        const data = deepRedact(raw);
        // Never leak the source host into the public snapshot; keep provenance.
        data.base_url = "https://<your-panel>:8443/api/external/v1";
        writeFileSync(snapshotPath, JSON.stringify(data, null, 2) + "\n");
        console.log(`Refreshed snapshot (panel ${data.panel_version ?? "unknown"}, ${data.generated_at ?? "no timestamp"})`);
        return data;
    }
    console.log("Reading committed snapshot");
    return JSON.parse(readFileSync(snapshotPath, "utf8"));
}

const spec = await loadSpec();
const { tools, stats } = buildTools(spec);
writeFileSync(outputPath, JSON.stringify(tools, null, 2) + "\n");

console.log(`Endpoints:   ${stats.total}`);
console.log(`Emitted:     ${stats.emitted}  (read ${stats.read}, mutate ${stats.mutate}, destructive ${stats.destructive})`);
console.log(`Skipped:     ${stats.skipped}`);
console.log(`Output:      tools/tools.json`);
