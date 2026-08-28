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

## 环境（异步）上下文

除了每个 logger 自身的上下文，lograil 还能附加一个**请求级**上下文：在某个代码块内（包含其后的 `await`）的所有日志都会自动继承它，而无需手动透传。它基于 Node 的 `AsyncLocalStorage` 实现，在浏览器中为空操作。

```ts
import { logger, runWithContext } from 'lograil';

app.use((req, res, next) => {
  // 请求处理函数内（及其 await 到的任何代码）的所有日志都会携带 `requestId`，
  // 无需手动透传。
  runWithContext(() => next(), { requestId: req.id });
});

// 之后，在请求中的任意位置：
logger.info('handling'); // => context: { requestId: '...' }
```

环境上下文会合并到 logger 自身上下文之上（冲突时环境上下文优先）。当没有激活的环境上下文时，日志不受影响且不产生额外分配。
