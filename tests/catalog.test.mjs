// Catalogue generator tests — run with `npm test` (node --test, no extra deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { buildTools, redactStr, deepRedact, toColonPath } = await import(resolve(__dirname, "../dist/catalog.js"));
const snapshot = JSON.parse(readFileSync(resolve(__dirname, "../tools/api-spec.json"), "utf8"));
const committed = JSON.parse(readFileSync(resolve(__dirname, "../tools/tools.json"), "utf8"));

test("committed tools.json is exactly what the generator produces from the snapshot", () => {
    const { tools } = buildTools(snapshot);
    assert.equal(tools.length, committed.length);
    assert.deepEqual(tools, committed);
});

test("every tool name is unique, ≤ 64 chars and prefixed", () => {
    const { tools } = buildTools(snapshot);
    const names = new Set();
    for (const t of tools) {
        assert.ok(t.name.length <= 64, t.name);
        assert.ok(t.name.startsWith("panelica_"), t.name);
        assert.ok(!names.has(t.name), `duplicate ${t.name}`);
        names.add(t.name);
    }
});

test("meta endpoints are not tools", () => {
    const { tools } = buildTools({ endpoints: [
        { method: "GET", path: "/health", category: "Core" },
        { method: "GET", path: "/v1/api-spec", category: "Core" },
        { method: "GET", path: "/v1/domains", category: "Domains" },
    ] });
    assert.deepEqual(tools.map((t) => t.metadata.path), ["/v1/domains"]);
});

test("annotations follow the HTTP method", () => {
    const { tools } = buildTools({ endpoints: [
        { method: "GET", path: "/v1/a", category: "X" },
        { method: "POST", path: "/v1/a", category: "X" },
        { method: "DELETE", path: "/v1/a/{id}", category: "X", request: { path_params: [{ name: "id", type: "uuid" }] } },
    ] });
    const by = Object.fromEntries(tools.map((t) => [t.metadata.method, t]));
    assert.equal(by.GET.annotations.readOnlyHint, true);
    assert.equal(by.POST.annotations.readOnlyHint, false);
    assert.equal(by.DELETE.annotations.destructiveHint, true);
    assert.equal(by.DELETE.metadata.path, "/v1/a/:id");
    assert.deepEqual(by.DELETE.inputSchema.required, ["id"]);
});

test("redaction strips identifiers, addresses, paths and keys", () => {
    const s = "user 3fa85f64-5717-4562-b3fc-2c963f66afa6 at 192.168.1.20 and 203.0.113.9:8443, mail a@b.co, path /opt/panelica/x, key pk_ABCDEFGHIJ";
    const r = redactStr(s);
    for (const bad of ["3fa85f64", "192.168", "203.0.113", "a@b.co", "/opt/panelica", "pk_ABCDEFGHIJ"]) {
        assert.ok(!r.includes(bad), `${bad} leaked: ${r}`);
    }
    assert.deepEqual(deepRedact({ a: ["x@y.com"], b: { c: "10.0.0.1" } }), { a: ["<email>"], b: { c: "<ip>" } });
    assert.equal(toColonPath("/v1/domains/{id}/dns/{record_id}"), "/v1/domains/:id/dns/:record_id");
});
