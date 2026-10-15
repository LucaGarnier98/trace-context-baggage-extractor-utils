import { test } from "node:test";
import assert from "node:assert/strict";
import { extract } from "../src/index.js";

test("extract parses a valid traceparent and baggage", () => {
  const ctx = extract({
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    baggage: "userId=42,role=admin",
  });
  assert.deepEqual(ctx.trace, {
    version: "00",
    traceId: "0af7651916cd43dd8448eb211c80319c",
    parentId: "b7ad6b7169203331",
    flags: "01",
  });
  assert.equal(ctx.baggage.get("userId"), "42");
  assert.equal(ctx.baggage.get("role"), "admin");
});

test("extract returns null trace when traceparent is absent", () => {
  const ctx = extract({ baggage: "k=v" });
  assert.equal(ctx.trace, null);
  assert.equal(ctx.baggage.get("k"), "v");
});

test("extract returns empty baggage map when baggage absent", () => {
  const ctx = extract({ traceparent: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01" });
  assert.equal(ctx.baggage.size, 0);
});

test("extract unwraps a { headers } envelope", () => {
  const ctx = extract({
    headers: {
      traceparent: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01",
      baggage: "x=1",
    },
  });
  assert.equal(ctx.trace.traceId, "a".repeat(32));
  assert.equal(ctx.baggage.get("x"), "1");
});

test("extract accepts a Map-like source with get()", () => {
  const m = new Map([
    ["traceparent", "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01"],
    ["baggage", "a=b"],
  ]);
  const ctx = extract(m);
  assert.equal(ctx.trace.parentId, "b".repeat(16));
  assert.equal(ctx.baggage.get("a"), "b");
});

test("extract is case-insensitive for header names", () => {
  const ctx = extract({
    TRACEPARENT: "00-" + "a".repeat(32) + "-" + "b".repeat(16) + "-01",
    BAGGAGE: "k=v",
  });
  assert.equal(ctx.trace.version, "00");
  assert.equal(ctx.baggage.get("k"), "v");
});

test("extract rejects traceparent with wrong traceId length", () => {
  const ctx = extract({ traceparent: "00-abc-b7ad6b7169203331-01" });
  assert.equal(ctx.trace, null);
});

test("extract rejects traceparent with non-hex chars", () => {
  const ctx = extract({
    traceparent: "00-" + "z".repeat(32) + "-" + "b".repeat(16) + "-01",
  });
  assert.equal(ctx.trace, null);
});

test("extract rejects all-zero traceId", () => {
  const ctx = extract({
    traceparent: "00-" + "0".repeat(32) + "-" + "b".repeat(16) + "-01",
  });
  assert.equal(ctx.trace, null);
});

test("extract rejects all-zero parentId", () => {
  const ctx = extract({
    traceparent: "00-" + "a".repeat(32) + "-" + "0".repeat(16) + "-01",
  });
  assert.equal(ctx.trace, null);
});

test("extract ignores baggage properties after semicolon", () => {
  const ctx = extract({ baggage: "k=v;prop=val;a=b" });
  assert.equal(ctx.baggage.get("k"), "v");
  assert.equal(ctx.baggage.size, 1);
});

test("extract last value wins on duplicate baggage keys", () => {
  const ctx = extract({ baggage: "k=1,k=2" });
  assert.equal(ctx.baggage.get("k"), "2");
});

test("extract percent-decodes baggage values", () => {
  const ctx = extract({ baggage: "k=hello%20world,url=http%3A%2F%2Fexample.org%2Fpath" });
  assert.equal(ctx.baggage.get("k"), "hello world");
  assert.equal(ctx.baggage.get("url"), "http://example.org/path");
});

test("extract leaves malformed percent sequences intact", () => {
  const ctx = extract({ baggage: "k=100%done" });
  assert.equal(ctx.baggage.get("k"), "100%done");
});

test("extract trims whitespace around baggage pairs", () => {
  const ctx = extract({ baggage: "  k = v  ,  x = y  " });
  assert.equal(ctx.baggage.get("k"), "v");
  assert.equal(ctx.baggage.get("x"), "y");
});

test("extract skips pairs with no equals sign", () => {
  const ctx = extract({ baggage: "valid=1,broken,also=2" });
  assert.equal(ctx.baggage.get("valid"), "1");
  assert.equal(ctx.baggage.get("also"), "2");
  assert.equal(ctx.baggage.size, 2);
});

test("extract handles empty baggage string", () => {
  const ctx = extract({ baggage: "" });
  assert.equal(ctx.baggage.size, 0);
});

test("extract joins array-valued headers with comma-space", () => {
  const ctx = extract({ baggage: ["a=1", "b=2"] });
  assert.equal(ctx.baggage.get("a"), "1");
  assert.equal(ctx.baggage.get("b"), "2");
});
