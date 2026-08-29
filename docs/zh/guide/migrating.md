# 迁移到 lograil

本页将 `electron-log`、`winston`、`pino` 的常见用法映射到 `lograil`，并指出行为差异，避免踩坑。

## 从 `electron-log` 迁移

和 `electron-log` 一样，`lograil` 在 Electron 下是**零配置**的——单个 `createLogger()`
（或默认的 `logger`）会自动探测自己运行在主进程还是渲染进程，并替你接好一切。
**不需要**配置 `transports`，也**不需要**写 IPC 对接代码：

- 在**渲染进程**中，日志既写本地 console，又自动经 IPC 转发到主进程。
- 在**主进程**中，日志写 console 和 `<appData>/Lograil/` 下的按日轮转文件；渲染进程
  日志经 IPC 接收后写入**独立**的 `renderer.{date}.log`，两个进程永不混在一起。

| `electron-log` | `lograil`（零配置默认） |
| --- | --- |
| `log.info('hi', meta)` | `logger.info('hi', meta)` |
| `log.scope('worker')` | `logger.scope('worker', { /* ctx */ })` / `logger.child({ context })` |
| `log.transports.console.level = 'info'` | 在 logger 上设 `level`——console transport 已自动添加 |
| `log.transports.file.fileName = 'app.log'` | 自动：`<appData>/Lograil/main.log`（+ `renderer.log`） |
| `log.transports.console.format = '[{level}] {text}'` | `ConsoleTransport` 的 formatter（通过自定义 runtime 覆盖） |
| `log.variables = { ... }` / `log.context` | `logger.setContext(key, value)` / `mergeContext` |
| `log.hooks.process`（改写条目） | 带 `onEntry` 的 `Plugin` |
| `log.transports.remote`（渲染→主进程） | **自动** IPC 转发——无需写代码 |

```ts
// main.ts 与 renderer.ts 相同，零配置：
import { logger } from 'lograil';

logger.info('在两个进程都能直接用');
```

**差异**
- `electron-log` 把 IPC 这一跳藏在一组固定 transport 后面；`lograil` 通过自身的 Electron
  runtime 执行同样的跳转，且只在你选择自定义 runtime 时才把它**显式化**。两者都不复制数据（零拷贝），
  参见[不可变性与零拷贝](../guide/immutability.md)。
- 级别固定为 `trace…fatal`，不像 electron-log 那样是可自定义的字符串映射。用 `setLevel` 映射旧名称。
- `lograil` 区分 `context`（持久）与 `metadata`（一次性），并在条目抵达 transport 前**冻结**，
  因此插件/transport 无法改共享状态。

### 进阶：手动控制（可选）

可以关闭或替换自动接线。仅当你选择退出（`forwardToMain: false` / `receiveFromRenderer: false`）
或用非 Electron 的 runtime 构造 logger 时才需要：

```ts
// 渲染进程——手动转发（替代默认渲染 runtime）
logger.addTransport(new ElectronIpcTransport());

// 主进程——手动接收（替代默认主 runtime）
import { registerIpcReceiver } from 'lograil';
registerIpcReceiver((entry) => logger.ingestEntry(entry));
```

完整零配置流程与安全 preload 配置见 [Electron 指南](../guide/electron.md)。

## 从 `winston` 迁移

`winston` 通过 `format.combine(...)` 与每个实例的 transports 组合；`lograil` 使用单一管道（`Filter`/`Processor`/`Formatter`）+ transports。

| `winston` | `lograil` |
| --- | --- |
| `createLogger({ transports: [new transports.Console(), new transports.File()] })` | `createLogger({ transports: [new ConsoleTransport(), new RotatingFileTransport({ path })] })` |
| `logger.log('info', msg, meta)` | `logger.info(msg, meta)` |
| `format.combine(format.json(), …)` | `createJsonFormatter()`（或 `createJsonFormatter({ flatten: true })`） |
| `format.timestamp()` / `format.colorize()` | 内置于 `createLineFormatter()` |
| `logger.child({ module })` | `logger.scope(...)` / `logger.child({ context })` |
| `transports.Http` | `OtlpTransport` 或自定义 `fetch` transport |
| 自定义 `Transport` 子类 | 实现 `Transport` 接口（`write(entry, formatted)`） |

**差异**
- `winston` 在每个 transport 上各自 `format`；`lograil` 在管道里**统一格式化一次**，transport 也可用自身 `formatter` 覆盖。
- `winston` 的 `meta` 对应 `lograil` 的 `context`/`metadata`。消息后的 `args` 是位置参数（`logger.info('msg', a, b)` → `entry.args = [a, b]`）。
- `lograil` 的 processor 可在格式化前归一化值（`createDefaultSerializers`）并脱敏（`createRedactProcessor`）。

## 从 `pino` 迁移

`pino` 是仅限 Node、极快的裸日志库。`lograil` 用少量纯 Node 吞吐换取**一流的 Web/Node/Electron 全平台支持**、结构化 `context`/`metadata`、插件管道与零拷贝 IPC。

| `pino` | `lograil` |
| --- | --- |
| `pino({ level })` | `createLogger({ level })` |
| `pino({ transport: { target: 'pino/file', options: { destination } } })` | `new RotatingFileTransport({ path })` |
| `pino-pretty` | `ConsoleTransport` + `createLineFormatter()` |
| `logger.child({ reqId })` | `logger.child({ context: { reqId } })` |
| `logger.info({ foo }, 'msg')` | `logger.info('msg', { foo })`（或 `logger.child({ context: { foo } })`） |
| `pino.destination` / `sonic-boom` | `RotatingFileTransport`（Node `fs`） |
| `pino` transports（worker 线程） | `ElectronIpcTransport` / `OtlpTransport` |

**差异**
- `pino` 仅运行于 Node；`lograil` 可运行在 Electron 主进程、Electron 渲染进程（经 `ElectronIpcTransport` 到主进程）以及 Web。
- `pino` 在纯 Node 吞吐上更快（C 层缓冲）。若你只在服务端日志且不涉及 Electron/浏览器，`pino` 也是好选择。
- `lograil` 额外提供：processor/插件管道、内置脱敏与序列化器、OTel trace 关联（`createOtelTracePlugin`）、按命名空间（模块名）过滤，以及冻结的不可变条目契约。

## 通用映射

| 概念 | `lograil` API |
| --- | --- |
| 输出 | `logger.trace/debug/info/warn/error/fatal` |
| 级别控制 | `setLevel`、transport 级 `level` |
| 结构化字段 | `context`（持久）/ `metadata`（一次性）/ `args` |
| 子 logger | `scope(name, ctx)` / `child({ context, level })` |
| 钩子 / 中间件 | `Plugin`（`onEntry`、`onInit`、`onTransport`、`onDestroy`） |
| 采样 | `createSampler`（filter） |
| 脱敏 | `createRedactProcessor` |
| 自定义落盘 | 实现 `Transport` |

完整 API 见[传输器](../guide/transports.md)、[管道](../api/pipeline.md)与[插件](../guide/plugins.md)指南。
