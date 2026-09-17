// Catalogue generator tests — run with `npm test` (node --test, no extra deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { buildTools, redactStr, deepRedact, toColonPath, returnsLine, idHint } = await import(resolve(__dirname, "../dist/catalog.js"));
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

test("id parameters say where their value comes from, even on a spec without descriptions", () => {
    const { tools } = buildTools({ endpoints: [
        { method: "GET", path: "/v1/domains", category: "Domains" },
        { method: "GET", path: "/v1/accounts", category: "Accounts" },
        { method: "GET", path: "/v1/domains/{id}", category: "Domains", request: { path_params: [{ name: "id", type: "uuid" }] } },
        { method: "GET", path: "/v1/dns/zones/{domain_id}/records", category: "DNS", request: { path_params: [{ name: "domain_id", type: "uuid" }] } },
        { method: "POST", path: "/v1/domains", category: "Domains", request: { body: { fields: [{ name: "user_id", type: "uuid", required: true }, { name: "name", type: "string", required: true }] } } },
    ] });
    const by = Object.fromEntries(tools.map((t) => [`${t.metadata.method} ${t.metadata.path}`, t]));
    assert.equal(by["GET /v1/domains/:id"].inputSchema.properties.id.description, "UUID of the domain — obtain it from GET /v1/domains");
    assert.equal(by["GET /v1/dns/zones/:domain_id/records"].inputSchema.properties.domain_id.description, "UUID of the domain — obtain it from GET /v1/domains");
    assert.equal(by["POST /v1/domains"].inputSchema.properties.body.properties.user_id.description, "UUID of the user — obtain it from GET /v1/accounts");
    // a hand-written description is never replaced
    const { tools: t2 } = buildTools({ endpoints: [{ method: "GET", path: "/v1/x/{id}", category: "X", request: { path_params: [{ name: "id", type: "string", description: "custom" }] } }] });
    assert.equal(t2[0].inputSchema.properties.id.description, "custom");
    assert.equal(idHint("thing_id", "/v1/a", new Set()), "ID of the thing");
});

test("response shapes become a Returns line and tool metadata", () => {
    const { tools } = buildTools({ endpoints: [
        { method: "GET", path: "/v1/accounts", category: "Accounts", response: { data_type: "array", keys: ["total"], fields: [{ name: "id", type: "uuid" }, { name: "username", type: "string" }] } },
        { method: "POST", path: "/v1/accounts/{id}/suspend", category: "Accounts", request: { path_params: [{ name: "id", type: "uuid" }], body: { content_type: "none" } }, response: { data_type: "none", fields: [{ name: "message", type: "string" }] } },
        { method: "GET", path: "/v1/old", category: "X" },
    ] });
    const by = Object.fromEntries(tools.map((t) => [t.metadata.path, t]));
    assert.match(by["/v1/accounts"].description, /Returns: \{status, data: array of \{id, username\}, total\}/);
    assert.deepEqual(by["/v1/accounts"].metadata.response.fields.map((f) => f.name), ["id", "username"]);
    assert.match(by["/v1/accounts/:id/suspend"].description, /Returns: \{status, message\}/);
    assert.equal(by["/v1/old"].metadata.response, undefined);
    assert.ok(!by["/v1/old"].description.includes("Returns:"));
    assert.equal(returnsLine({ data_type: "object", fields: Array.from({ length: 15 }, (_, i) => ({ name: `f${i}` })) }), "Returns: {status, data: object {f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, … (+3 more)}}");
});

test("enums, defaults, scope rules, roles and shaping params reach the tool schema", async () => {
    const { scopesLine, shapingApplies } = await import(resolve(__dirname, "../dist/catalog.js"));
    const { tools } = buildTools({ endpoints: [
        { method: "POST", path: "/v1/domains", category: "Domains", auth: { required: true, scopes: ["domains:write"] }, request: { body: { fields: [{ name: "web_server", type: "string", enum: ["nginx_apache", "nginx_only"], default: "nginx_apache" }] } } },
        { method: "GET", path: "/v1/antivirus/status", category: "Antivirus", auth: { required: true, scopes: ["accounts:read", "security:read"], scope_rule: "one of security:read, accounts:read" } },
        { method: "GET", path: "/v1/logs/access", category: "Logs", auth: { required: true, scopes: ["logs:read"], roles: ["ADMIN", "ROOT"] }, response: { data_type: "array", fields: [{ name: "line", type: "string" }] } },
        { method: "GET", path: "/v1/search", category: "Core", auth: { required: true }, request: { query_params: [{ name: "q", type: "string", required: true }] } },
        { method: "GET", path: "/v1/domains/{id}", category: "Domains", auth: { required: true, scopes: ["domains:read"] }, request: { path_params: [{ name: "id", type: "uuid" }] }, response: { data_type: "object" } },
    ] });
    const by = Object.fromEntries(tools.map((t) => [t.metadata.path, t]));
    const ws = by["/v1/domains"].inputSchema.properties.body.properties.web_server;
    assert.deepEqual(ws.enum, ["nginx_apache", "nginx_only"]);
    assert.equal(ws.default, "nginx_apache");
    assert.match(by["/v1/antivirus/status"].description, /Required scopes: one of security:read, accounts:read/);
    assert.equal(by["/v1/antivirus/status"].metadata.scopeRule, "one of security:read, accounts:read");
    assert.match(by["/v1/logs/access"].description, /Restricted to key owners with role: ADMIN, ROOT/);
    assert.match(by["/v1/search"].description, /Required scopes: none \(any valid API key\)/);
    // shaping params only on list-returning GETs
    assert.ok(by["/v1/logs/access"].inputSchema.properties._limit && by["/v1/logs/access"].metadata.shaping === true);
    assert.ok(by["/v1/search"].inputSchema.properties._match, "unknown-shape collection GET gets shaping too");
    assert.equal(by["/v1/domains/:id"].inputSchema.properties._limit, undefined);
    assert.equal(by["/v1/domains"].inputSchema.properties._limit, undefined);
    assert.equal(shapingApplies({ method: "GET", path: "/v1/x", response: { data_type: "object" } }), false);
    assert.equal(scopesLine({ method: "GET", path: "/x", auth: { required: false } }), "");
});
