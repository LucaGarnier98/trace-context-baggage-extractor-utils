# trace-context-baggage-extractor-utils

Parses and normalizes `traceparent` (W3C Trace Context) and `baggage` headers from a request-like object into a typed key-value map for downstream propagation.

## Usage

```js
import { extract } from "trace-context-baggage-extractor-utils";

const headers = {
  "traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  "baggage": "userId=42,role=admin"
};

const ctx = extract(headers);
// ctx.trace.version === "00"
// ctx.trace.traceId === "0af7651916cd43dd8448eb211c80319c"
// ctx.trace.parentId === "b7ad6b7169203331"
// ctx.trace.flags === "01"
// ctx.baggage.get("userId") === "42"
// ctx.baggage.get("role") === "admin"
```

`extract(source)` accepts any object with a `get(name)` method, plain string keys, or a `{ headers }` wrapper. Returned baggage keys and values are trimmed and URL-decoded; invalid `traceparent` fields are dropped (never thrown).

## Why

Propagation plumbing should not drag in a runtime framework. This library extracts the two headers that actually matter for downstream tracing, validates them against the W3C grammar, and hands back plain data. The trade-off: we intentionally do not merge multiple `baggage` headers or parse `tracestate`; if you need either, this is the wrong layer.

## Edge cases

- Duplicate baggage keys: the **last** value wins, matching W3C Baggage spec guidance for receivers.
- `traceparent` with wrong field lengths or non-hex characters is returned as `trace: null` rather than partially parsed.
- Case-insensitive header lookup: `TraceParent` and `BAGGAGE` resolve the same as lowercase.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

