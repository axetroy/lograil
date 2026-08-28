# 上下文

上下文用于管理与每条日志绑定在一起的结构化字段。可通过 `logger.setContext` / `logger.mergeContext` 使用，也可直接管理一个存储。

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

## 用法

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

## 层级关系

`ctx.child()` 会创建一个以当前值作为种子的新存储。作用域 logger（`logger.scope`）会自动获得隔离的子存储，因此在子 logger 上设置的上下文不会泄漏到其父级。
