import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { CORE_TOOLS, selectTools, parseToolsets, findTools, metaTools, summarize } = await import(resolve(__dirname, "../dist/toolsets.js"));
const all = JSON.parse(readFileSync(resolve(__dirname, "../tools/tools.json"), "utf8"));

test("every core entry exists in the catalogue and the default stays under Cursor's 40-tool cap", () => {
    const keys = new Set(all.map((t) => `${t.metadata.method} ${t.metadata.path}`));
    for (const k of CORE_TOOLS) assert.ok(keys.has(k), `core tool missing from catalogue: ${k}`);
    const core = selectTools(all, parseToolsets(undefined));
    assert.equal(core.length, CORE_TOOLS.length);
    assert.ok(core.length + metaTools(all.length, core.length).length <= 40);
});

test("toolset parsing and unions", () => {
    assert.deepEqual(parseToolsets(""), ["core"]);
    assert.deepEqual(parseToolsets(" Core, GIT "), ["core", "git"]);
    assert.equal(selectTools(all, ["all"]).length, all.length);
    assert.equal(selectTools(all, ["none"]).length, 0);
    const git = selectTools(all, ["git"]);
    assert.ok(git.length > 30 && git.every((t) => t.metadata.category === "Git"));
    assert.equal(selectTools(all, ["core", "git"]).length, CORE_TOOLS.length + git.length - CORE_TOOLS.filter((k) => k.includes("/v1/git")).length);
});

test("find_tools ranks path matches first and requires every term", () => {
    const hits = findTools(all, "dns records", 5);
    assert.ok(hits.length > 0);
    assert.ok(hits[0].metadata.path.includes("/dns/"), hits[0].metadata.path);
    assert.equal(findTools(all, "zzz-nonexistent-term").length, 0);
    const s = summarize(hits[0]);
    assert.ok(s.name && s.http && Array.isArray(s.params));
});

test("meta tools carry safety annotations", () => {
    const [find, call] = metaTools(10, 5);
    assert.equal(find.annotations.readOnlyHint, true);
    assert.equal(call.annotations.destructiveHint, true);
});
