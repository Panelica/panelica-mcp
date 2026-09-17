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
