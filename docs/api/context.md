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
