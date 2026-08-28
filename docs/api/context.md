# Context

Context manages structured fields attached to every log entry. Access it via
`logger.setContext` / `logger.mergeContext`, or manage a store directly.

```ts
interface ContextStore {
  get(): Record<string, unknown>;
  set(key: string, value: unknown): void;
  merge(values: Record<string, unknown>): ContextStore;
  delete(key: string): void;
  clear(): void;
  child(): ContextStore;
}

function createContextStore(initial?: Record<string, unknown>): ContextStore;
```

## Usage

```ts
import { createContextStore } from 'lograil';

const ctx = createContextStore({ env: 'prod' });
ctx.set('requestId', 'abc-123');
ctx.merge({ tenant: 'acme' });
ctx.get();
// { env: 'prod', requestId: 'abc-123', tenant: 'acme' }

ctx.delete('tenant');
ctx.clear();
```

## Hierarchy

`ctx.child()` creates a new store seeded with the current values. Scoped loggers
(`logger.scope`) automatically receive an isolated child store, so context set on
a child never leaks to its parent.

## Ambient (async) context

Beyond per-logger context, lograil can attach a **request-scoped** context that
every log call inside a block inherits automatically — including across `await`.
This is built on Node's `AsyncLocalStorage` and is a no-op in browsers.

```ts
import { logger, runWithContext } from 'lograil';

app.use((req, res, next) => {
  // Every log inside the request handler (and anything it awaits) carries
  // `requestId`, with no manual plumbing.
  runWithContext(() => next(), { requestId: req.id });
});

// later, anywhere in the request:
logger.info('handling'); // => context: { requestId: '...' }
```

Ambient context is merged on top of the logger's own context (ambient wins on
collision). When no ambient context is active, logging is unaffected and
allocation-free.

## Exports

```ts
function runWithContext<T>(fn: () => T, context: Record<string, unknown>): T;
function isEmptyRecord(o: Record<string, unknown>): boolean;

const asyncContext: {
  run<T>(fn: () => T, context: Record<string, unknown>): T;
  runAsync<T>(fn: () => Promise<T>, context: Record<string, unknown>): Promise<T>;
  get(): Record<string, unknown>;
  supported(): boolean;
};
```

- `runWithContext(fn, ctx)` — run `fn` with `ctx` active as the ambient logging
  context for every log call inside it (including across `await`). See the example
  above.
- `asyncContext` — the underlying propagation primitive. `run` / `runAsync` enter a
  context scope (the latter for async `fn`); `get()` returns the currently active
  context (or `{}`); `supported()` is `true` on Node (backed by `AsyncLocalStorage`)
  and `false` in the browser build (where ambient context is a no-op).
- `isEmptyRecord(o)` — `true` when `o` has no own enumerable keys. Exported for
  callers building their own context or sampling logic.
