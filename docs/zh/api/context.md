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

## 导出

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

- `runWithContext(fn, ctx)` —— 以 `ctx` 作为环境日志上下文运行 `fn`，其内部（含 `await` 之后）的所有日志都会携带它（见上方示例）。
- `asyncContext` —— 底层传播原语。`run` / `runAsync` 进入一个上下文作用域（后者用于异步 `fn`）；`get()` 返回当前激活的上下文（无则为 `{}`）；`supported()` 在 Node 上为 `true`（基于 `AsyncLocalStorage`），在浏览器构建上为 `false`（环境上下文为空操作）。
- `isEmptyRecord(o)` —— 当 `o` 没有自有可枚举键时为 `true`。导出供需要自行构建上下文或采样逻辑的调用方使用。
