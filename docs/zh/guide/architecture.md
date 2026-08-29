# 架构

`lograil` 采用分层设计，让每个关注点彼此隔离、便于测试。一次日志调用会按可预测的顺序流经这些层。

## 分层

```
  log.info(message, ...args)
          │
          ▼
   ┌───────────────┐
   │   Logger      │  构建结构化的 LogEntry（时间戳、作用域、
   │  （门面）      │  上下文、元数据、error、级别）
   └───────────────┘
          │
          ▼
   ┌───────────────┐
   │   Pipeline     │  1. 过滤器  —— 丢弃条目（如按级别/作用域）
   │                │  2. 处理器  —— 转换/增强/脱敏/序列化
   │                │  3. 格式化器 —— 序列化为字符串/JSON
   └───────────────┘
          │
          ▼
   ┌───────────────┐
   │  Plugins      │  异步拦截每条条目（可丢弃/修改），
   │               │  并可在运行时添加传输器 / 重构管道
   └───────────────┘
          │
          ▼
   ┌───────────────┘
   │  Transports   │  最终落点：控制台、滚动文件、IPC、OTLP、自定义
   └───────────────┘
          ▲
          │
   ┌───────────────┐
   │  Runtime       │  隔离环境差异（时钟、pid、文件系统、默认值）
   │  Adapter       │  —— 自动探测，或显式传入
   └───────────────┘

   Context  —— 附加到每条日志中的持久化结构化字段（另含可选的
              环境异步上下文）。
```

- **Logger**：把调用转换为 `LogEntry`。第一个参数可以是 `string`、`Error` 或任意值（对象会被保留为结构化数据）。
- **Pipeline**：先运行 `Filter`（返回 `false` 即丢弃），再依次运行 `Processor`（增强/脱敏/序列化……），最后由 `Formatter` 生成线上形态。内置处理器 `createRedactProcessor`、`createSerializeProcessor` 即插于此。
- **Plugins**：在管道之后通过每条条目的异步 `intercept` 钩子运行。可丢弃条目（返回 `null`）或改写，并通过 `PluginContext` 在运行时重新配置 logger。
- **Transports**：最终落点（控制台、`rotating file`、IPC、`OTLP` 或自定义）。`write` 可以是异步的；若是异步，logger 会在 `flush()` / `destroy()` 时等待其完成。每个传输器还可声明自己的 `level` 做独立过滤。
- **Runtime Adapter**：抽象环境差异（Web / Node / Electron），因此同一套 logger 代码处处可用。
- **Context**：合并进每条日志的 `context` 字段；作用域 logger 会获得隔离的子上下文。此外还有**环境（异步）上下文**——基于 `AsyncLocalStorage` 的请求级字段，在 `await` 之间自动继承，会被叠加在 logger 上下文之上（浏览器中为无操作）。

## 异步与生命周期

从调用方视角看，日志记录是同步的，但写入会经由内部队列排空，因此异步传输器与插件拦截都不会阻塞你的代码：

```ts
logger.info('done'); // 立即返回
await logger.flush(); // 等待队列（含异步写入）清空
await logger.destroy(); // 先 flush，再释放插件、关闭传输器
```

由于插件的 `onEntry` 钩子会被 `await` 并链式执行，且异步传输写入会进入队列，因此在进程退出前调用 `flush()`（或 `destroy()`）能保证缓冲区中的日志不丢失。Logger 通过运行时的 `lifecycle` 钩子来接线 flush / 崩溃行为：所以 `autoFlushOnExit`（或 `attachExitHandlers`）会在宿主退出时 flush——Node 的 `beforeExit` / `SIGINT` / `SIGTERM`、Electron **主进程**的 `app` `before-quit` / `will-quit`、Web 的 `pagehide` / `visibilitychange`；`watchUncaughtErrors` 会把未捕获异常 / 未处理的拒绝以 `fatal` 记录后再退出；`redirectConsole` 把 `console.*` 桥接进 logger。

## 过滤发生在哪里

有三道相互独立的闸门：

1. **logger 级别闸门**：`setLevel` 在条目进入管道前丢弃低于阈值的条目，因此被廉价丢弃的条目不会消耗处理成本。
2. **管道过滤器**：任意谓词（`createLevelFilter`、`createScopeFilter`、`createSampler`、`combineFilters`、自定义）在管道内运行。
3. **按传输器级别**：每个传输器可声明自己的 `level`；低于它的条目仅被该传输器跳过，从而让一个 logger 分流（例如 `error` 及以上发往远端，其余写入文件）。

## 为何如此分层

- **关注点分离**：格式化与目标解耦——同一条目可以用不同格式同时进入控制台和文件。
- **可组合**：过滤器/处理器/传输器都是普通函数或对象，易于单元测试与复用。
- **可扩展**：插件可在运行时重构管道、添加落点，而无需改动业务代码。
- **可移植**：运行时适配器使同一套 API 在 Web、Node 与 Electron 上通用，包括 Electron 中渲染进程→主进程的日志汇聚。
