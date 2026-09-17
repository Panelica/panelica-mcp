import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { CORE_TOOLS, selectTools, parseToolsets, findTools, metaTools, summarize, describeTool, META_FIND, META_DESCRIBE, META_CALL } = await import(resolve(__dirname, "../dist/toolsets.js"));
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
    const by = Object.fromEntries(metaTools(10, 5).map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(by).sort(), [META_CALL, META_DESCRIBE, META_FIND].sort());
    assert.equal(by[META_FIND].annotations.readOnlyHint, true);
    assert.equal(by[META_DESCRIBE].annotations.readOnlyHint, true);
    assert.equal(by[META_CALL].annotations.destructiveHint, true);
});

test("describeTool lists params, body fields and the response envelope", async () => {
    const { buildTools } = await import(resolve(__dirname, "../dist/catalog.js"));
    const { tools } = buildTools({ endpoints: [
        { method: "GET", path: "/v1/domains", category: "Domains", response: { data_type: "array", keys: ["total"], fields: [{ name: "id", type: "uuid" }] } },
        { method: "GET", path: "/v1/accounts", category: "Accounts" },
        { method: "GET", path: "/v1/domains/{id}", category: "Domains", request: { path_params: [{ name: "id", type: "uuid" }] }, response: { data_type: "object", fields: [{ name: "id", type: "uuid" }, { name: "domain_name", type: "string" }] } },
        { method: "POST", path: "/v1/domains", category: "Domains", request: { body: { content_type: "application/json", required: true, fields: [{ name: "name", type: "string", required: true }, { name: "user_id", type: "uuid", required: true }, { name: "php_version", type: "string", description: "8.1, 8.2 (default: 8.3)" }] } } },
        { method: "POST", path: "/v1/legacy", category: "X" },
    ] });
    const by = Object.fromEntries(tools.map((t) => [`${t.metadata.method} ${t.metadata.path}`, t]));
    const d = describeTool(by["POST /v1/domains"]);
    assert.equal(d.http, "POST /v1/domains");
    assert.equal(d.risk, "mutating");
    assert.equal(d.body_required, true);
    assert.ok(Array.isArray(d.body) && d.body.some((f) => f.name === "user_id" && f.required === true && /GET \/v1\/accounts/.test(f.description)), JSON.stringify(d.body));
    assert.match(d.response.note, /not available/);
    const g = describeTool(by["GET /v1/domains/:id"]);
    assert.equal(g.body, "none");
    assert.equal(g.risk, "read-only");
    assert.deepEqual(g.params, [{ name: "id", type: "string", required: true, description: "UUID of the domain — obtain it from GET /v1/domains" }]);
    assert.equal(g.response.envelope, "{status, data: object}");
    assert.deepEqual(g.response.fields.map((f) => f.name), ["id", "domain_name"]);
    assert.equal(describeTool(by["GET /v1/domains"]).response.envelope, "{status, data: array, total}");
    assert.equal(describeTool(by["POST /v1/legacy"]).body, "free-form object — see the panel's API docs");
    assert.equal(summarize(by["GET /v1/domains"]).returns, "array of {id}");
});
