/**
 * Core extraction logic for trace-context and baggage headers.
 *
 * Design decisions (stated plainly so the tests and README stay honest):
 *
 * 1. traceparent parsing follows the W3C Trace Context Level 1 grammar:
 *    version-traceId-parentId-flags, each field hex. We validate length and
 *    charset and return null on any violation rather than a partial object —
 *    a half-valid trace context is worse than none, because downstream code
 *    would propagate garbage.
 * 2. baggage parsing follows W3C Baggage: comma-separated key=value pairs,
 *    optional properties (key=value after ';') which we ignore, percent-decoded
 *    values, whitespace-trimmed keys and values. Duplicate keys: last value wins
 *    (receiver behavior per the spec).
 * 3. Header lookup is case-insensitive. We accept three shapes so callers don't
 *    need to normalize: a Map-like { get } object, a plain record of strings,
 *    or { headers: <either of the above> }.
 */

/**
 * @typedef {Object} TraceContext
 * @property {string} version  2 hex chars.
 * @property {string} traceId  32 hex chars.
 * @property {string} parentId 16 hex chars.
 * @property {string} flags    2 hex chars.
 */

/**
 * @typedef {Object} ExtractResult
 * @property {TraceContext|null} trace   Validated trace context, or null.
 * @property {Map<string,string>} baggage  Decoded baggage map (empty if none).
 */

const HEX_RE = /^[0-9a-f]*$/i;

/**
 * Resolve a header value from heterogeneous request shapes, case-insensitively.
 * Returns string, string[], or undefined.
 *
 * @param {any} source
 * @param {string} name
 * @returns {string | string[] | undefined}
 */
function lookupHeader(source, name) {
  if (source === null || typeof source !== "object") {
    return undefined;
  }

  // Unwrap a { headers } envelope (e.g. fetch Request). Only unwrap once to
  // avoid surprising nesting behavior.
  const candidate = source && typeof source === "object" && "headers" in source && source.headers
    ? source.headers
    : source;

  // Map-like (Headers, custom { get }). Prefer this path because it handles
  // case-insensitivity for us when the underlying impl does.
  if (typeof candidate.get === "function") {
    try {
      const v = candidate.get(name);
      if (v !== null && v !== undefined) return v;
      // Fall through to manual scan.
    } catch {
      // Some get() implementations throw on odd input; fall through.
    }
  }

  // Plain record. Linear scan for case-insensitive match.
  if (typeof candidate === "object") {
    const lower = name.toLowerCase();
    for (const key of Object.keys(candidate)) {
      if (key.toLowerCase() === lower) {
 return candidate[key];
      }
    }
  }

  return undefined;
}

/**
 * Coerce a header value (which may be an array for multi-valued headers) into a
 * single string. We join arrays with ", " because that is the standard way to
 * fold repeated headers into one line for downstream parsing.
 *
 * @param {string | string[] | undefined} value
 * @returns {string}
 */
function coerceString(value) {
  if (value === undefined || value === null) return "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/**
 * Parse a traceparent header string into a validated TraceContext, or null.
 *
 * @param {string} raw
 * @returns {TraceContext | null}
 */
function parseTraceParent(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;

  const parts = raw.split("-");
  if (parts.length < 4) return null;

  const [version, traceId, parentId, flags] = parts;

  // W3C fixed-length fields. Reject anything that doesn't match exactly;
  // a trace context with the wrong number of bytes is not propagatable.
  if (!version || version.length !== 2 || !HEX_RE.test(version)) return null;
  if (!traceId || traceId.length !== 32 || !HEX_RE.test(traceId)) return null;
  if (!parentId || parentId.length !== 16 || !HEX_RE.test(parentId)) return null;
  if (!flags || flags.length !== 2 || !HEX_RE.test(flags)) return null;

  // Reject the all-zero traceId/parentId: the spec forbids them because they
  // are indistinguishable from "uninitialized".
  if (traceId === "00000000000000000000000000000000") return null;
  if (parentId === "0000000000000000") return null;

  return { version, traceId, parentId, flags };
}

/**
 * Decode a percent-encoded baggage token per RFC 3986. We use a small
 * hand-rolled decoder rather than decodeURIComponent because baggage values
 * may contain characters (spaces, equals, commas) that were encoded to avoid
 * ambiguity in the wire format, and we want to tolerate malformed sequences
 * gracefully (passing them through unchanged) instead of throwing.
 *
 * @param {string} str
 * @returns {string}
 */
function decode(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "%") {
      const hex = str.slice(i + 1, i + 3);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
      } else {
        // Malformed escape — preserve literally rather than throw.
        out += ch;
      }
    } else if (ch === "+") {
      // Baggage does not define '+' as space (unlike query strings), but some
      // clients misuse it. We leave '+' untouched to avoid silent corruption
      // of values that genuinely contain plus signs.
      out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Parse a baggage header string into a Map. Returns a fresh Map always, empty
 * if input is empty or whitespace-only.
 *
 * @param {string} raw
 * @returns {Map<string, string>}
 */
function parseBaggage(raw) {
  /** @type {Map<string, string>} */
  const map = new Map();
  if (typeof raw !== "string" || raw.trim().length === 0) return map;

  const pairs = raw.split(",");
  for (const pair of pairs) {
    if (pair.trim().length === 0) continue;

    // A pair may carry properties: key=value;prop1=val1;prop2=val2.
    // We only care about the leading key=value for propagation.
    const segments = pair.split(";");
    const main = segments[0];
    if (!main) continue;

    const eq = main.indexOf("=");
    if (eq === -1) continue;

    const key = main.slice(0, eq).trim();
    const value = main.slice(eq + 1).trim();
    if (key.length === 0) continue;

    // Last value wins for duplicates. decode() is applied to both so encoded
    // equals signs in keys survive correctly.
    map.set(decode(key), decode(value));
  }

  return map;
}

/**
 * Extract trace context and baggage from a request-like object.
 *
 * @param {any} source  Request, Headers, or plain object with header keys.
 * @returns {ExtractResult}
 */
export function extract(source) {
  const traceRaw = coerceString(lookupHeader(source, "traceparent"));
  const baggageRaw = coerceString(lookupHeader(source, "baggage"));

  return {
    trace: parseTraceParent(traceRaw),
    baggage: parseBaggage(baggageRaw),
  };
}
