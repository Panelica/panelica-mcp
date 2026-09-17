// Error explanation + result bounding — run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { explainError, boundResult, humanizeKey } = await import(resolve(__dirname, "../dist/errors.js"));

const base = { statusText: "", method: "GET", path: "/v1/databases", headers: {} };

test("403 with a scope names the missing scope and says not to retry", () => {
    const t = explainError({ ...base, status: 403, body: JSON.stringify({ status: "error", error: { code: "apiErrors.external.insufficientScope", message: "Insufficient scope", required_scope: "databases:read", available_scopes: ["domains:read"] }, request_id: "r1" }) });
    assert.match(t, /lacks the scope "databases:read"/);
    assert.match(t, /it has: domains:read/);
    assert.match(t, /Retrying cannot help/);
    assert.match(t, /request_id: r1/);
});

test("404 tells the model to re-list instead of guessing ids", () => {
    const t = explainError({ ...base, status: 404, method: "GET", path: "/v1/domains/abc", body: JSON.stringify({ status: "error", error: "Domain not found" }) });
    assert.match(t, /never invent or reuse one/);
    assert.match(t, /Message: Domain not found/);
});

test("429 reports the reset window from the rate-limit headers", () => {
    const reset = Math.floor(Date.now() / 1000) + 30;
    const t = explainError({ ...base, status: 429, body: "{}", headers: { "x-ratelimit-remaining-minute": "0", "x-ratelimit-reset-minute": String(reset) } });
    assert.match(t, /resets in about (29|30|31)s/);
    assert.match(t, /remaining this minute: 0/);
});

test("401 and 5xx point at the operator, 400 at the arguments; non-JSON bodies survive", () => {
    assert.match(explainError({ ...base, status: 401, body: "<html>nope</html>" }), /tell the operator to check the key/);
    assert.match(explainError({ ...base, status: 500, body: JSON.stringify({ status: "error", error: "boom", details: "SQLSTATE 42703", request_id: "q" }) }), /Details: SQLSTATE 42703[\s\S]*request_id q/);
    assert.match(explainError({ ...base, status: 400, body: JSON.stringify({ status: "error", error: "Key: 'Name' Error:Field validation" }) }), /panelica_describe_tool/);
});

test("oversized list results are cut to the first items with a note; small ones pass through", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: `id-${i}`, name: "x".repeat(50) }));
    const text = JSON.stringify({ status: "success", data: items, total: 500 });
    const out = boundResult(text, 5000);
    const j = JSON.parse(out);
    assert.ok(out.length <= 5000, String(out.length));
    assert.equal(j._truncated.total, 500);
    assert.equal(j.data.length, j._truncated.shown);
    assert.equal(j.total, 500);
    assert.equal(boundResult("short", 100), "short");
    assert.match(boundResult("y".repeat(200), 100), /truncated: 100 more chars/);
});

test("untranslated message keys from older panels become words", () => {
    assert.equal(humanizeKey("apiErrors.external.domain.notFound"), "Domain not found");
    assert.equal(humanizeKey("apiErrors.external.insufficientScopeForMethod"), "Insufficient scope for method");
    assert.equal(humanizeKey("Domain not found"), "Domain not found");
    assert.match(explainError({ status: 404, statusText: "", method: "GET", path: "/v1/x", headers: {}, body: JSON.stringify({ status: "error", error: "apiErrors.external.domain.notFound" }) }), /Message: Domain not found/);
});

test("Gin validation messages become field-level guidance with JSON names", async () => {
    const { humanizeValidation } = await import(resolve(__dirname, "../dist/errors.js"));
    const msg = "Key: 'CreateDomainRequest.UserID' Error:Field validation for 'UserID' failed on the 'required' tag\nKey: 'CreateDomainRequest.PHPVersion' Error:Field validation for 'PHPVersion' failed on the 'oneof' tag";
    assert.equal(humanizeValidation(msg, ["name", "user_id", "php_version"]), 'field "user_id" is required; field "php_version" must be one of the allowed values (see the enum in the tool schema)');
    assert.equal(humanizeValidation("Key: 'Name' Error:Field validation for 'Name' failed on the 'required' tag"), 'field "name" is required');
    assert.equal(humanizeValidation("Domain not found"), undefined);
    const t = explainError({ ...base, status: 400, method: "POST", body: JSON.stringify({ status: "error", error: "Key: 'Name' Error:Field validation for 'Name' failed on the 'required' tag" }) }, ["name", "type"]);
    assert.match(t, /Validation: field "name" is required/);
});

test("result shaping filters, projects and limits list results and reports what it did", async () => {
    const { takeShaping, shapeResult } = await import(resolve(__dirname, "../dist/errors.js"));
    const { rest, shaping } = takeShaping({ domain_id: "x", _limit: "2", _fields: "id, name", _match: "Alpha" });
    assert.deepEqual(rest, { domain_id: "x" });
    assert.deepEqual(shaping, { limit: 2, fields: ["id", "name"], match: "alpha" });
    const text = JSON.stringify({ status: "success", data: [
        { id: 1, name: "alpha-1", php: "8.3" }, { id: 2, name: "beta", php: "8.2" }, { id: 3, name: "Alpha-3", php: "8.1" }, { id: 4, name: "alpha-4", php: "8.4" },
    ], total: 4 });
    const j = JSON.parse(shapeResult(text, shaping));
    assert.deepEqual(j.data, [{ id: 1, name: "alpha-1" }, { id: 3, name: "Alpha-3" }]);
    assert.deepEqual(j._shaped, { total: 4, matched: 3, shown: 2, fields: ["id", "name"], match: "alpha" });
    assert.equal(j.total, 4);
    assert.equal(shapeResult(text, {}), text);
    assert.equal(shapeResult('{"status":"success","data":{"id":1}}', { limit: 1 }), '{"status":"success","data":{"id":1}}');
    assert.equal(shapeResult("not json", { limit: 1 }), "not json");
});
