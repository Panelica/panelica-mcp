/**
 * Error explanation — turns a failed External API call into text an AI
 * assistant can act on.
 *
 * The panel answers errors with {"status":"error","error":<string|{code,message,…}>,
 * "details"?, "request_id"?}. Scope failures add required_scope / available_scopes;
 * rate limiting adds X-RateLimit-* headers. A raw "403 Forbidden" makes a model
 * retry or guess; naming the missing scope, the bad id, or the reset time lets
 * it do the right next thing (ask the operator, re-list, wait) instead.
 */

export interface FailedCall {
    status: number;
    statusText: string;
    method: string;
    path: string;
    body: string;
    headers: Record<string, string>;
}

interface ParsedError {
    message: string;
    code?: string;
    details?: string;
    requestId?: string;
    requiredScope?: string;
    availableScopes?: string[];
}

function parseErrorBody(body: string): ParsedError {
    let j: unknown;
    try { j = JSON.parse(body); } catch { return { message: body.trim().slice(0, 500) }; }
    if (!j || typeof j !== "object") return { message: String(body).slice(0, 500) };
    const o = j as Record<string, unknown>;
    const err = o.error ?? o.message;
    const out: ParsedError = { message: "" };
    if (typeof err === "string") out.message = err;
    else if (err && typeof err === "object") {
        const e = err as Record<string, unknown>;
        out.message = String(e.message ?? e.error ?? "");
        if (typeof e.code === "string") out.code = e.code;
        if (typeof e.required_scope === "string") out.requiredScope = e.required_scope;
        if (Array.isArray(e.available_scopes)) out.availableScopes = e.available_scopes.map(String);
        if (e.details !== undefined) out.details = typeof e.details === "string" ? e.details : JSON.stringify(e.details);
    }
    if (typeof o.details === "string") out.details = o.details;
    else if (o.details !== undefined && out.details === undefined) out.details = JSON.stringify(o.details);
    if (typeof o.request_id === "string") out.requestId = o.request_id;
    if (typeof o.code === "string" && !out.code) out.code = o.code;
    return out;
}

/**
 * Older panels answered External API errors with the untranslated
 * message key ("apiErrors.external.domain.notFound"). Turn such a key into
 * readable words so the model is not left with an identifier.
 */
export function humanizeKey(msg: string): string {
    if (!/^api(Errors|Success)\.[A-Za-z0-9_.]+$/.test(msg)) return msg;
    const last = msg.split(".").slice(2).join(" ");
    const words = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : msg;
}

function header(h: Record<string, string>, name: string): string | undefined {
    const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
    return k ? h[k] : undefined;
}

const TAG_TEXT: Record<string, string> = {
    required: "is required",
    min: "is below the minimum length/value",
    max: "exceeds the maximum length/value",
    len: "has the wrong length",
    email: "must be a valid e-mail address",
    url: "must be a valid URL",
    uuid: "must be a UUID", uuid4: "must be a UUID",
    oneof: "must be one of the allowed values (see the enum in the tool schema)",
    gte: "is below the allowed minimum", gt: "is below the allowed minimum",
    lte: "is above the allowed maximum", lt: "is above the allowed maximum",
    alphanum: "must contain only letters and digits", alpha: "must contain only letters", numeric: "must be numeric",
    ip: "must be an IP address", ipv4: "must be an IPv4 address", ipv6: "must be an IPv6 address",
    fqdn: "must be a valid hostname", hostname: "must be a valid hostname",
    startswith: "must start with the expected prefix", endswith: "must end with the expected suffix",
};

/**
 * Gin/validator messages look like
 *   Key: 'CreateDomainRequest.UserID' Error:Field validation for 'UserID' failed on the 'required' tag
 * Map the Go field back to the JSON name the caller used and say what is wrong.
 */
export function humanizeValidation(msg: string, jsonFields: string[] = []): string | undefined {
    const re = /Field validation for '([A-Za-z0-9_]+)' failed on the '([A-Za-z0-9_]+)' tag/g;
    const norm = (x: string) => x.toLowerCase().replace(/_/g, "");
    const out: string[] = [];
    for (const m of msg.matchAll(re)) {
        const goName = m[1];
        const json = jsonFields.find((f) => norm(f) === norm(goName)) ?? goName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
        out.push(`field "${json}" ${TAG_TEXT[m[2]] ?? `failed the "${m[2]}" rule`}`);
    }
    return out.length ? out.join("; ") : undefined;
}

/** One paragraph of guidance per status class, followed by the raw body for reference. */
export function explainError(c: FailedCall, jsonFields: string[] = []): string {
    const p = parseErrorBody(c.body);
    const where = `${c.method} ${c.path}`;
    const lines: string[] = [`Panelica API error ${c.status}${c.statusText ? ` ${c.statusText}` : ""} on ${where}`];
    const validation = p.message ? humanizeValidation(p.message, jsonFields) : undefined;
    if (validation) lines.push(`Validation: ${validation}`);
    else if (p.message) lines.push(`Message: ${humanizeKey(p.message)}`);
    if (p.details) lines.push(`Details: ${p.details.slice(0, 800)}`);

    switch (true) {
        case c.status === 400 || c.status === 422:
            lines.push(
                "What to do: the panel rejected the arguments (missing/invalid field, bad id format or an unsupported value). " +
                "Check the exact parameters with panelica_describe_tool and fix the call; do not repeat it unchanged.");
            break;
        case c.status === 401:
            lines.push(
                "What to do: authentication failed for the API key configured in this MCP server (PANELICA_API_KEY/SECRET) — " +
                "invalid or expired key, wrong secret, or the panel and this machine disagree on the time. " +
                "This is not fixable from the conversation: tell the operator to check the key in the panel (Settings → API Keys) and the server clock. Do not retry.");
            break;
        case c.status === 403 && !!p.requiredScope:
            lines.push(
                `What to do: the API key lacks the scope "${p.requiredScope}"` +
                (p.availableScopes?.length ? ` (it has: ${p.availableScopes.join(", ")})` : "") +
                ". Retrying cannot help — ask the operator to add that scope to the key in the panel (Settings → API Keys), or use a read-only alternative.");
            break;
        case c.status === 403:
            lines.push(
                "What to do: forbidden for this key's owner — the resource belongs to another account, or the owner's role (user/reseller/admin) may not perform this action. " +
                "Do not retry with guessed ids; re-list the resources visible to this key and, if the action needs higher privileges, tell the operator.");
            break;
        case c.status === 404:
            lines.push(
                "What to do: no such resource for this key's owner. Ids are UUIDs that must come from a list call (e.g. GET /v1/domains, GET /v1/accounts) — " +
                "never invent or reuse one from memory. Re-list, pick the id from the result, then call again.");
            break;
        case c.status === 409:
            lines.push(
                "What to do: conflict — the resource already exists, is in a state that forbids this action, or an integration is not configured " +
                "(e.g. Cloudflare credentials missing). Read the message, check current state with the matching GET tool, and only then decide.");
            break;
        case c.status === 429: {
            const remM = header(c.headers, "X-RateLimit-Remaining-Minute");
            const resetM = header(c.headers, "X-RateLimit-Reset-Minute");
            const retry = header(c.headers, "Retry-After");
            let wait = "";
            if (retry) wait = `Retry after ${retry}s.`;
            else if (resetM && /^\d+$/.test(resetM)) {
                const secs = Math.max(1, Number(resetM) - Math.floor(Date.now() / 1000));
                wait = `The per-minute window resets in about ${secs}s.`;
            }
            lines.push(
                `What to do: rate limit of the API key's tier reached${remM !== undefined ? ` (remaining this minute: ${remM})` : ""}. ${wait} ` +
                "Wait, then continue with fewer calls (prefer one list call over many single GETs). A higher tier is set by the operator on the API key.");
            break;
        }
        case c.status === 503:
            lines.push("What to do: the panel service behind this endpoint is unavailable right now (service down or starting). Wait a moment and retry once; if it persists, tell the operator.");
            break;
        case c.status >= 500:
            lines.push(
                "What to do: the panel failed internally — not caused by your arguments. Do not loop on retries; report the message" +
                (p.requestId ? ` and request_id ${p.requestId}` : "") + " to the operator, and continue with other tasks.");
            break;
        default:
            lines.push("What to do: read the message above; check the tool's parameters with panelica_describe_tool before calling again.");
    }
    if (p.requestId && c.status !== 500) lines.push(`request_id: ${p.requestId}`);
    lines.push(`Raw response: ${c.body.slice(0, 1500)}`);
    return lines.join("\n");
}

export interface Shaping { limit?: number; fields?: string[]; match?: string; }

/** Pull _limit/_fields/_match out of the arguments (they never reach the panel). */
export function takeShaping(args: Record<string, unknown>): { rest: Record<string, unknown>; shaping: Shaping } {
    const { _limit, _fields, _match, ...rest } = args;
    const shaping: Shaping = {};
    if (_limit !== undefined && _limit !== null && String(_limit) !== "") shaping.limit = Math.max(0, Math.floor(Number(_limit)));
    if (typeof _fields === "string" && _fields.trim()) shaping.fields = _fields.split(",").map((f) => f.trim()).filter(Boolean);
    if (typeof _match === "string" && _match.trim()) shaping.match = _match.trim().toLowerCase();
    return { rest, shaping };
}

/**
 * Apply client-side shaping to a {status, data: [...]} result: filter by
 * substring, project fields, cut to N items. Adds a _shaped note so the model
 * knows what it is looking at. Non-list results pass through untouched.
 */
export function shapeResult(text: string, s: Shaping): string {
    if (s.limit === undefined && !s.fields && !s.match) return text;
    let j: Record<string, unknown>;
    try { j = JSON.parse(text) as Record<string, unknown>; } catch { return text; }
    if (!j || !Array.isArray(j.data)) return text;
    const total = j.data.length;
    let items = j.data as unknown[];
    if (s.match) items = items.filter((it) => JSON.stringify(it).toLowerCase().includes(s.match as string));
    const matched = items.length;
    if (s.fields) {
        const keep = new Set(s.fields);
        items = items.map((it) => (it && typeof it === "object" && !Array.isArray(it))
            ? Object.fromEntries(Object.entries(it as Record<string, unknown>).filter(([k]) => keep.has(k)))
            : it);
    }
    if (s.limit !== undefined) items = items.slice(0, s.limit);
    return JSON.stringify({ ...j, data: items, _shaped: { total, matched, shown: items.length, ...(s.fields ? { fields: s.fields } : {}), ...(s.match ? { match: s.match } : {}) } });
}

/**
 * Keep successful results within a size the client can hold. Large list
 * responses are cut to the first items with an explicit note (valid JSON
 * stays valid); anything else is truncated as text with a note.
 */
export function boundResult(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    try {
        const j = JSON.parse(text) as Record<string, unknown>;
        const data = j?.data;
        if (Array.isArray(data) && data.length > 1) {
            const total = data.length;
            let keep = data.length;
            let out = "";
            // Halve until it fits — a few iterations at most.
            do {
                keep = Math.max(1, Math.floor(keep / 2));
                out = JSON.stringify({ ...j, data: data.slice(0, keep), _truncated: { shown: keep, total, note: `Result too large (${text.length} chars); showing the first ${keep} of ${total} items. Narrow the query (filters, a specific id) to see the rest.` } });
            } while (out.length > maxChars && keep > 1);
            return out;
        }
    } catch { /* not JSON */ }
    return text.slice(0, maxChars) + `\n…[truncated: ${text.length - maxChars} more chars — narrow the request to see the rest]`;
}
