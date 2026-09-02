# 上下文与元数据

`LogEntry` 携带两个独立的对象字段 —— `context` 和 `metadata` —— 它们服务于不同的目的。正确使用它们能让日志保持结构化，并避免意外泄露数据。

## context — 请求级、可继承

`context` 是**持久化**且**可继承**的。它存在于 `ContextStore` 上，会自动流入 logger 产生的每一条条目。

```ts
const log = createLogger();

// 每个请求（或每个逻辑工作单元）设置一次
log.setContext('userId', 'u-123');
log.setContext('requestId', crypto.randomUUID());

// 后续每条条目都携带这些字段
log.info('handled request');
// → { context: { userId: 'u-123', requestId: '...' }, ... }
```

子 logger 会获得一份**独立的**上下文，从父级继承初始值：

```ts
const reqLog = log.scope('api').child({
  context: { tenantId: 'acme' },
});

reqLog.info('query executed');
// → { context: { userId: 'u-123', requestId: '...', tenantId: 'acme' }, ... }
```

**何时使用 `context`：**
- 属于*请求*或*会话*的数据：`userId`、`requestId`、`tenantId`、`sessionId`
- 只设置一次并在多次日志调用中复用的值
- 希望子 logger 自动继承的字段

**异步上下文** — 在 Node.js 上，库还支持 `asyncContext`（基于 `AsyncLocalStorage`）。在那里设置的值会自动合并到同一异步作用域内的每条条目中，无需手动调用 `setContext`：

```ts
import { asyncContext } from 'lograil';

asyncContext.with({ traceId: 'abc' }, async () => {
  log.info('inside async scope'); // traceId 自动合并
});
```

## metadata — 单条条目级、一次性

`metadata` 仅附加到**单条日志条目**。它不会被继承，也不会跨调用持久化。默认情况下它是共享的空记录（`{}`），因此热路径不产生任何分配。

metadata 通常由 **processor** 或 **plugin** 注入，而非由应用代码直接设置：

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

**何时使用 `metadata`：**
- 单条测量值：`durationMs`、`retryCount`、`statusCode`
- 由插件注入的环境信息：`host`、`pid`、`buildVersion`
- 不应该跨请求泄露的数据（与 context 相反）

## 总结

|                | `context`                          | `metadata`                      |
|----------------|------------------------------------|----------------------------------|
| **生命周期**   | 持久化（直到清除）                  | 单条条目                         |
| **继承**       | 子 logger 会继承                    | 从不继承                         |
| **来源**       | `log.setContext()` 或 `asyncContext` | Processor / Plugin              |
| **典型用途**   | `userId`、`requestId`、`tenantId`   | `durationMs`、`host`、`pid`      |
| **默认值**     | 空 store                            | 共享冻结的 `{}`（零分配）         |

## 常见错误：把请求数据放在 metadata 里

不要把请求级数据放在 `metadata` 中——它不会传播到子 logger，而且如果你修改对象，它会跨请求泄露：

```ts
// ❌ 错误：metadata 不会继承，且修改它会影响所有条目
log.error('fail', {}, { userId: 'u-123' }); // 第三个参数成为 metadata，下次调用丢失

// ✅ 正确：用 context 存放请求级数据
log.setContext('userId', 'u-123');
log.error('fail');
```
