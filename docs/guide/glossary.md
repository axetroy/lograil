# 术语表

本文档解释 lograil 中使用的主要术语，帮助初学者快速理解。

## 核心概念

### LogEntry（日志条目）

单条日志记录，包含所有日志信息（级别、消息、时间戳、作用域、上下文、元数据等）。日志创建后是**不可变**的（frozen），不能被修改。

```ts
interface LogEntry {
  level: number;        // 数值级别（trace=10, debug=20, ...）
  levelName: string;    // 字符串级别（'info', 'error' 等）
  message: string;      // 日志消息
  args: unknown[];      // 结构化参数
  timestamp: number;    // 毫秒时间戳
  scope?: string;       // 作用域名称（如 'api'）
  context: Record<string, unknown>; // 请求级上下文（userId, requestId 等）
  metadata: Record<string, unknown>; // 单次条目的元数据（durationMs, host 等）
  error?: unknown;      // 错误对象
}
```

### Pipeline（管线）

日志处理管道，由三个组件串联而成：**过滤器（Filter）→ 处理器（Processor）→ 格式化器（Formatter）**。每条日志依次经过这三个阶段。

```
你的代码 → Logger → [过滤器 → 处理器 → 格式化器] → 传输器 → 输出
                              ↓
                          Pipeline
```

### Filter（过滤器）

决定是否保留某条日志。返回 `true` 则保留，返回 `false` 则丢弃（跳过后续处理）。

典型用途：按级别过滤、按作用域过滤、采样过滤。

```ts
type Filter = (entry: LogEntry) => boolean;
```

### Processor（处理器）

修改或增强日志条目。返回新的 `LogEntry`（或 `null` 丢弃）。

典型用途：添加元数据、脱敏敏感字段、采样。

```ts
type Processor = (entry: LogEntry) => LogEntry | null;
```

### Formatter（格式化器）

将 `LogEntry` 转换为字符串输出。

内置格式化器：
- `createLineFormatter()` — 可读的行格式（用于控制台）
- `createJsonFormatter()` — JSON 格式（结构化输出）

```ts
type Formatter = (entry: LogEntry, config: FormatterConfig) => string;
```

### Transport（传输器）

日志的"出口"，决定日志写到哪里。每个传输器有自己的级别阈值和格式化器。

内置传输器：
- `ConsoleTransport` — 输出到 `console.*`
- `FileTransport` — 写入文件（支持轮转）
- `ElectronIpcTransport` — 通过 IPC 转发到 Electron 主进程
- `OtlpTransport` — 发送到 OpenTelemetry Collector

```ts
interface Transport {
  name: string;
  formatter?: Formatter;
  level?: LogLevelInput;
  write(entry: LogEntry, formatted: string): void | Promise<void>;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

## 运行时概念

### Runtime Adapter（运行时适配器）

桥接 lograil 与特定运行时的组件。自动检测当前环境（Web / Node.js / Electron），提供：
- 文件系统访问（Node/Electron）
- 进程 ID（`pid()`）
- 退出处理（`beforeExit` / `SIGINT` / `SIGTERM`）
- IPC 支持（Electron）

### IPC（进程间通信）

Inter-Process Communication，进程间通信。在 Electron 中，渲染进程通过 IPC 将日志转发到主进程，由主进程写入文件。

### OTLP（开放遥测协议）

OpenTelemetry Protocol，OpenTelemetry 的传输协议。lograil 通过 `OtlpTransport` 将日志发送到 OpenTelemetry Collector，实现与 tracing 系统的集成。

### ESM / CJS

- **ESM**（ECMAScript Modules）— 现代 JavaScript 模块系统，使用 `import` / `export`
- **CJS**（CommonJS）— 传统 Node.js 模块系统，使用 `require()` / `module.exports`

lograil 同时提供两种格式的构建，方便不同项目使用。

### Tree-shaking

一种优化技术，打包工具（如 Vite、Webpack）会移除未使用的代码。lograil 的子路径导出（如 `lograil/core`）支持 tree-shaking，只引入需要的部分。

## 日志级别

从低到高：

| 级别 | 数值 | 用途 |
|------|------|------|
| trace | 10 | 最详细的调试信息 |
| debug | 20 | 开发调试 |
| info | 30 | 常规信息 |
| warn | 40 | 警告 |
| error | 50 | 错误 |
| fatal | 60 | 致命错误 |

## 作用域（Scope）

用 `:` 分隔的模块标识，如 `app:http`、`app:db`。用于区分不同模块的日志，也可用于过滤器。

```ts
const http = logger.scope('http'); // scope 为 'app:http'
http.info('request received');    // 日志中包含 scope: 'app:http'
```

## 上下文（Context）

通过 `setContext()` 设置的键值对，会**自动附加到每条日志**。用于请求级数据，如 `userId`、`requestId`。

子 logger 会从父级继承 context，但每个子 logger 有独立的拷贝。

```ts
logger.setContext('userId', 'u-123');
logger.info('hello'); // → { context: { userId: 'u-123' }, ... }
```

## 元数据（Metadata）

单条日志的额外字段，通常由 **processor** 或 **plugin** 注入。不会跨调用持久化。

```ts
// processor 示例：添加耗时
const timingProcessor: Processor = (entry) => ({
  ...entry,
  metadata: { ...entry.metadata, durationMs: Date.now() - entry.startTime },
});
```

## 异步上下文

基于 Node.js `AsyncLocalStorage` 的上下文管理。在异步操作链中自动传播上下文，无需手动传递。

```ts
import { asyncContext } from 'lograil';

asyncContext.with({ traceId: 'abc' }, async () => {
  await someAsyncWork(); // 这条异步链路中的日志都会携带 traceId
});
```

## 插件（Plugin）

可扩展日志行为的组件。插件可以：
- 添加/移除传输器
- 修改管道（过滤器、处理器、格式化器）
- 拦截并修改每条日志

```ts
interface Plugin {
  name: string;
  onInit?(ctx: PluginContext): void;
  onEntry?(entry: LogEntry): LogEntry | null;
  onTransport?(transport: Transport): void;
  onDestroy?(): void;
}
```
