# Context & Metadata

`LogEntry` carries two separate object fields — `context` and `metadata` — that serve different purposes. Using them correctly keeps logs structured and avoids accidental data leakage.

## context — Request-scoped, inherited

`context` is **persistent** and **inherited**. It lives on the `ContextStore` and flows automatically into every entry a logger produces.

```ts
const log = createLogger();

// Set once per request (or per logical unit of work)
log.setContext('userId', 'u-123');
log.setContext('requestId', crypto.randomUUID());

// Every subsequent entry carries these fields
log.info('handled request');
// → { context: { userId: 'u-123', requestId: '...' }, ... }
```

Child loggers get their **own isolated** context seeded from the parent:

```ts
const reqLog = log.scope('api').child({
  context: { tenantId: 'acme' },
});

reqLog.info('query executed');
// → { context: { userId: 'u-123', requestId: '...', tenantId: 'acme' }, ... }
```

**When to use `context`:**
- Data that belongs to the *request* or *session*: `userId`, `requestId`, `tenantId`, `sessionId`
- Values set once and reused across many log calls
- Fields you want child loggers to inherit automatically

**Async context** — on Node.js the library also supports `asyncContext` (via `AsyncLocalStorage`). Values set there are merged into every entry within the same async scope, without calling `setContext` manually:

```ts
import { asyncContext } from 'lograil';

asyncContext.with({ traceId: 'abc' }, async () => {
  log.info('inside async scope'); // traceId is merged automatically
});
```

## metadata — Entry-scoped, one-off

`metadata` is attached to a **single log entry only**. It is not inherited and does not persist between calls. By default it is the shared empty record (`{}`) so the hot path allocates nothing.

Metadata is typically injected by a **processor** or **plugin**, not set directly by application code:

```ts
import { createLogger, type Processor } from 'lograil';

const timingProcessor: Processor = (entry) => ({
  ...entry,
  metadata: { ...entry.metadata, durationMs: Date.now() - entry.timestamp },
});

const log = createLogger({
  pipeline: { processors: [timingProcessor] },
});
```

**When to use `metadata`:**
- Per-entry measurements: `durationMs`, `retryCount`, `statusCode`
- Environment details injected by plugins: `host`, `pid`, `buildVersion`
- Data that should **not** leak across requests (unlike context)

## Summary

|                | `context`                          | `metadata`                      |
|----------------|------------------------------------|----------------------------------|
| **Lifetime**   | Persistent (until cleared)         | Single entry                    |
| **Inheritance**| Child loggers inherit              | Never inherited                 |
| **Source**     | `log.setContext()` or `asyncContext` | Processors / plugins            |
| **Typical use**| `userId`, `requestId`, `tenantId`  | `durationMs`, `host`, `pid`     |
| **Default**    | Empty store                        | Shared frozen `{}` (zero alloc) |

## Common mistake: using metadata for request data

Don't put request-scoped values in `metadata` — they won't propagate to child loggers and will leak across requests if you mutate the object:

```ts
// ❌ Wrong: metadata doesn't inherit, and mutating it affects all entries
log.error('fail', {}, { userId: 'u-123' }); // third arg becomes metadata, lost next call

// ✅ Right: use context for request-scoped data
log.setContext('userId', 'u-123');
log.error('fail');
```
