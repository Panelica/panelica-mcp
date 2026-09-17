// Server instructions are generated from the catalogue — run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { buildInstructions } = await import(resolve(__dirname, "../dist/instructions.js"));
const { selectTools } = await import(resolve(__dirname, "../dist/toolsets.js"));
const all = JSON.parse(readFileSync(resolve(__dirname, "../tools/tools.json"), "utf8"));

test("instructions mention every category, the meta tools and only recipes whose steps exist", () => {
    const registered = selectTools(all, ["core"]);
    const text = buildInstructions({ tools: all, registered, toolsets: ["core"], source: "snapshot (test)" });
    for (const cat of new Set(all.map((t) => t.metadata.category))) assert.ok(text.includes(`${cat} (`), cat);
    for (const m of ["panelica_find_tools", "panelica_describe_tool", "panelica_call"]) assert.ok(text.includes(m), m);
    assert.match(text, /COMMON WORKFLOWS/);
    assert.match(text, /Provision a hosting account/);
    const have = new Set(all.map((t) => `${t.metadata.method} ${t.metadata.path}`));
    for (const line of text.split("\n").filter((l) => l.startsWith("- ") && l.includes(" → "))) {
        for (const step of line.split(": ")[1].split(" → ")) assert.ok(have.has(step), `recipe step not in catalogue: ${step}`);
    }
    assert.ok(text.length < 6000, `instructions too long: ${text.length}`);
});

test("a tiny catalogue yields no recipes and no dangling references", () => {
    const tiny = all.filter((t) => t.metadata.path === "/v1/me");
    const text = buildInstructions({ tools: tiny, registered: tiny, toolsets: ["all"], source: "snapshot (tiny)" });
    assert.ok(!text.includes("COMMON WORKFLOWS"));
    assert.match(text, /1 tools = the Panelica/);
});
