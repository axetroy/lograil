# Pipeline

The pipeline turns a `LogEntry` into a formatted string via three stages:
**filters** (drop), **processors** (transform), and a **formatter** (serialize).

## Filter

```ts
type Filter = (entry: LogEntry) => boolean;

function createLevelFilter(minLevel: number): Filter;
function createScopeFilter(allowed: string[]): Filter;
function createSampler(options?: SamplingOptions): Filter;
function combineFilters(filters: Filter[]): Filter;
```

### Sampling

`createSampler` drops entries to cut volume, with two orthogonal strategies combined
by logical AND:

- **probabilistic** (`rate`, 0..1): keep each entry with probability `rate`;
- **rate limiting** (`maxPerSecond` + `burst`): a token bucket caps throughput per
  second, tolerating short bursts.

Entries outside `levels` (or when `levels` is omitted, every level) are always kept.
Because it is a filter, sampled entries never reach processors, formatters or
transports — the cheapest way to reduce cost under load. Sampling is intentionally
lossy; enable it only for high-volume, low-value levels.

```ts
logger.getPipeline().addFilter(
  createSampler({ levels: ['debug', 'info'], maxPerSecond: 100, burst: 200 }),
);
```

## Processor

```ts
type Processor = (entry: LogEntry) => LogEntry;

const identityProcessor: Processor;

function createRedactProcessor(keys: string[], replacement?: unknown): Processor;
function createSerializeProcessor(serializers: Record<string, Serializer>): Processor;
```

`createRedactProcessor` redacts sensitive data **before** formatting — it walks
`context`, `metadata` and each element of `args`, replacing any value whose path
matches one of `keys` with `replacement` (default `"[REDACTED]"`; may be any value).

- A bare key, e.g. `'password'`, matches any property of that name at any depth.
- A dotted spec, e.g. `'user.password'`, matches only that exact path.
- `*` matches any single key/index: `'*.password'` redacts every `password`,
  `'user.*'` redacts everything directly under `user`.

The original objects are never mutated; only the branches that actually contain a
match are cloned, so when nothing matches the entry is returned unchanged.

### Serializers

```ts
type Serializer = (value: unknown, entry: LogEntry) => unknown;
```

`createSerializeProcessor` **normalizes** values by key name **before** formatting.
For every property named `key` found in `context`, `metadata`, each element of
`args` (and the entry's `error`), the matching serializer replaces the value. This
is the structured-log equivalent of pino's `serializers` — use it to redact
sensitive fields, flatten large objects, or render framework objects (requests,
DB rows) consistently.

- Matching is by property name at **any depth** — a `req` serializer runs on any
  object that has a `req` property.
- The `entry` is passed as the second argument for contextual serialization.
- Transformation is structural: only the branches that contain a matching key are
  cloned; when no serializer fires the entry is returned unchanged.

```ts
import { createSerializeProcessor, createRedactProcessor } from 'lograil';

logger.getPipeline().addProcessor(
  createSerializeProcessor({
    err: (e) => ({ name: e.name, message: e.message, stack: e.stack }),
    user: (u) => ({ id: u.id }), // keep only the id
  }),
);
```

Run serializers **before** `createRedactProcessor` so redaction can mask the
already-normalized output.

#### Real-world example

A web server that logs every request. The raw `req`/`user` objects are huge and
leaky (headers, cookies, sockets, password hashes) — serializers keep only what
you need and pair with redaction as a safety net:

```ts
const log = createLogger({
  pipeline: {
    processors: [
      createSerializeProcessor({
        // keep only safe fields; drop headers/cookies/socket
        req: (r: any) => ({ method: r.method, url: r.url, ip: r.ip }),
        // user carries a passwordHash — expose id + role only
        user: (u: any) => ({ id: u.id, role: u.role }),
        // expand errors into a readable shape
        err: (e: any) => ({ name: e.name, message: e.message, stack: e.stack }),
      }),
      // redact anything sensitive that slipped through
      createRedactProcessor(['token', 'authorization', 'cookie']),
    ],
  },
});

// later, inside a request handler:
log.info('request handled', { req, user, err });
```

The emitted JSON line stays useful while avoiding secret leakage:

```json
{
  "level": "info",
  "message": "request handled",
  "args": [
    {
      "req": { "method": "GET", "url": "/api/me", "ip": "203.0.113.7" },
      "user": { "id": 42, "role": "admin" }
    }
  ]
}
```

## Formatter

```ts
type Formatter<T = string> = (entry: LogEntry) => T;

function createLineFormatter(): Formatter<string>;
function createJsonFormatter(): Formatter<string>;
```

- `createLineFormatter` — one human-readable line including the full `Error`
  cause chain.
- `createJsonFormatter` — structured JSON with `error` serialized via
  `errorToJson` (circular `cause` safe).

## Pipeline API

```ts
class Pipeline {
  constructor(options?: PipelineOptions);
  process(entry: LogEntry): LogEntry | null; // runs filters + processors
  addFilter(filter: Filter): void;
  removeFilter(filter: Filter): void;
  addProcessor(processor: Processor): void;
  removeProcessor(processor: Processor): void;
  setFormatter(formatter: Formatter): void;
  getFormatter(): Formatter;
}
```

`PipelineOptions` can be passed to `createLogger({ pipeline })` to configure the
pipeline declaratively:

```ts
interface PipelineOptions {
  filters?: Filter[];
  processors?: Processor[];
  formatter?: Formatter;
}
```

Access and mutate the active pipeline at runtime:

```ts
import { createRedactProcessor } from 'lograil';

logger.getPipeline().addProcessor(createRedactProcessor(['password']));
```
