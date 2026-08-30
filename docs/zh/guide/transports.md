# 传输器

**传输器（Transport）** 是日志条目的最终落点——控制台、文件、IPC，或你自己的目标。`Transport` 接口刻意保持精简：

```ts
interface Transport {
  /** 唯一名称，用于诊断与移除。 */
  readonly name: string;
  /** 可选的、覆盖管道默认值的每传输器格式化器。 */
  readonly formatter?: Formatter;
  /** 可选的最小级别；低于它的条目仅被该落点跳过。 */
  readonly level?: LogLevelInput;
  /** 输出一条已处理的条目（同步或异步均可）。 */
  write(entry: LogEntry, formatted: string): void | Promise<void>;
  /** 可选：刷新，由 `logger.flush()` 等待。 */
  flush?(): void | Promise<void>;
  /** 可选：资源释放。 */
  close?(): void | Promise<void>;
}
```

## 内置传输器

### ConsoleTransport

写入全局 `console`，将每个级别映射到对应的方法（`warn` → `console.warn`，`error`/`fatal` → `console.error`，……）。

```ts
import { ConsoleTransport, createLineFormatter } from 'lograil';

new ConsoleTransport({
  name: 'console',
  formatter: createLineFormatter(),
  methodMap: { fatal: (...a) => console.error('FATAL', ...a) },
});

通过 `methodMap` 可把某个级别路由到不同的 `console` 方法，或为其输出加前缀。默认每个级别映射到同名的 `console` 方法，且 `fatal` 映射到 `console.error`（因此在多数终端里会出现在 `stderr`）。

### FileTransport

面向 Node.js 与 Electron 主进程、带多种模式的文件传输器。`appName` 必填，
且始终是文件名的一部分。模式是一个判别联合，所以每种模式只暴露自己的字段：

```ts
import { FileTransport, createJsonFormatter } from 'lograil';

// 1.1 / 1.2 — 单文件（一直追加，或超 maxSize 时截断）
new FileTransport({
  mode: 'single', // 或 'single-truncate'
  appName: 'my-app',
  maxSize: 10 * 1024 * 1024, // 'single-truncate' 必填
  formatter: createJsonFormatter(),
});

// 2.1 — 按体积轮转；fileName() 自定义归档名
new FileTransport({
  mode: 'rotate-size',
  appName: 'my-app',
  maxSize: 10 * 1024 * 1024,
  maxFiles: 5,
  fileName: (app, index, ext) => `${app}.${index}.${ext}`,
  formatter: createJsonFormatter(),
});

// 2.2 — 按时间轮转；每天一个带日期的文件
new FileTransport({
  mode: 'rotate-time',
  appName: 'my-app',
  unit: 'day',
  fileName: (app, stamp, ext) => `${app}.${stamp}.${ext}`,
  formatter: createJsonFormatter(),
});

// 2.3 — 按自定义谓词轮转
new FileTransport({
  mode: 'rotate-custom',
  appName: 'my-app',
  shouldRotate: (entry) => entry.levelName === 'error',
  fileName: (app, seq, ext) => `${app}.${seq}.${ext}`,
  formatter: createJsonFormatter(),
});
```

- **`single`** — 单个 `<appName>.log` 文件，一直追加（直到磁盘写满）。
- **`single-truncate`** — 同样是单文件，但一旦即将超过 `maxSize`，当前内容被改名为 `<appName>.bak`，原文件原地截断。
- **`rotate-size`** — 当 `size + bytes > maxSize` 时，按 `maxFiles` 推移代际（`app.log` → `app.1.log` → …）。
- **`rotate-time`** — 在每个 `hour`/`day` 边界开启新文件，并以时间戳命名。
- **`rotate-custom`** — `shouldRotate(entry, ctx)` 决定何时切分；`fileName` 为每个文件命名。对轮转拥有完全控制。

利用 `filter` 选项可把单个 logger 的输出拆分到多个文件——例如内置的 Electron 主进程运行时给主进程与渲染进程各分配一个 `FileTransport`（`appName: 'main'` / `'renderer'`），从而分开两者日志。

### ElectronIpcTransport

渲染进程侧的传输器，通过 IPC 将每条条目转发到主进程。`electron` 模块采用惰性加载，因此在 Electron 之外导入也是安全的。

```ts
import { ElectronIpcTransport } from 'lograil';

const log = createLogger({
  runtime: createWebRuntime(), // 渲染进程没有文件系统
  transports: [new ElectronIpcTransport()],
});
```

在主进程中，启用 IPC 接收，以便渲染进程的日志被持久化：

```ts
import { createElectronMainRuntime, registerIpcReceiver } from 'lograil';

const log = createLogger({ runtime: createElectronMainRuntime() });
// 或直接使用默认主进程运行时（已自动挂载接收器）
```

### OtlpTransport

通过 OTLP HTTP/JSON 把日志转发到 OpenTelemetry Collector（或任意 OTLP 接收端）。
日志会被缓冲并按批次发送；在进程退出前调用 `flush()`（或开启 logger 的
`autoFlushOnExit`）以排空。需要全局 `fetch`（Node >= 18、现代浏览器、Electron 均支持）。

```ts
import { OtlpTransport } from 'lograil';

new OtlpTransport({
  endpoint: 'http://localhost:4318/v1/logs', // OTLP HTTP 接收端
  serviceName: 'my-service',
  resource: { 'deployment.environment': 'prod' },
});
```

上下文中的 `traceId` / `spanId`（或 `trace_id` / `span_id`）会自动映射进 OTLP 的
链路关联字段，使日志能与其所在的分布式链路在后端关联。

借助按传输器 `level`，可以让一个 logger 分流——例如把 `OtlpTransport` 设为
`error`，文件传输器设为 `info`。

### LiveTransport

一个内存型、可订阅的传输器，用于**实时日志流**——它不写入落点，而是把每条
条目转发给进程内的订阅者。它是调试面板、webview 日志查看器，或渲染日志流的
React/Vue Hook 的基石。零依赖、跨运行时（Web、Node、Electron 通用）。

消费日志流有两种方式，取决于你想怎么渲染：

#### 按实体渲染（`subscribe`）

你拿到的是**原始、已冻结的 `LogEntry`**，可以随意渲染——级别徽标、可展开的
`context`/`metadata` 树、点击复制、按字段过滤等。当你的 UI 是结构化的
（按条目 key 的 React/Vue 组件）而非纯文本日志时，选这个。

```ts
import { LiveTransport } from 'lograil';

const live = new LiveTransport({ bufferSize: 100 });
logger.addTransport(live);

// entry 已冻结且零拷贝——切勿修改它。
const unsubscribe = live.subscribe((entry) => {
  // 例如 <LogRow level={entry.levelName} msg={entry.message} ctx={entry.context} />
  renderRow(entry);
});
```

#### 按格式化字符串渲染（`onFormatted`）

你拿到的是**预格式化好的文本行**（由传输器的 formatter 生成；未设置时取条目的
`message`），直接追加到文本视图即可。当你只需要一个类控制台的纯文本面板时，选这个。

```ts
import { LiveTransport, createLineFormatter } from 'lograil';

const live = new LiveTransport({ formatter: createLineFormatter() });
logger.addTransport(live);

// line 已格式化；若需要，entry 也会一并传入。
const unsubscribe = live.onFormatted((line, entry) => {
  appendLine(line); // 例如 textarea / <pre> / 终端组件
});
```

> 两种模式是独立的订阅——可以只用其一，也可以同时使用。`subscribe` 始终给原始
> 条目；`onFormatted` 仅在确实挂了格式化订阅者时才惰性计算字符串。

#### 回放、缓冲与释放

```ts
// 后加入的订阅者可回放缓冲（newestFirst 为 true 时最新在前）。
live.replay((entry) => backfill(entry), true);

console.log(live.subscriberCount); // 当前订阅者数量
live.clearBuffer(); // 清空缓冲
unsubscribe(); // 停止接收
```

关键行为：

- **热路径安全。** 订阅者抛出的异常会被捕获并记录，绝不会中断 logger 的 `write()` 或其他订阅者。
- **零拷贝。** 订阅者拿到的是管道产出的同一个已冻结 `LogEntry` 引用——不要修改它。
- **缓冲。** 设置 `bufferSize > 0` 可为后加入的订阅者保留环形缓冲（通过 `replay` 回放）。`0`（默认）完全关闭缓冲。
- **释放。** `close()` 会清空所有订阅者与缓冲。

对于跨进程流式传输（Electron 主进程 → 渲染进程/webview），可配合现有的 IPC 通道使用；
跨标签页的 Web 流式传输则使用 `BroadcastChannelTransport`。

## 自定义传输器

只需实现 `Transport` 接口即可：

```ts
import type { Transport, LogEntry } from 'lograil';

const httpTransport: Transport = {
  name: 'http',
  write(entry: LogEntry, formatted: string) {
    fetch('https://logs.example.com', {
      method: 'POST',
      body: formatted,
    });
  },
};
```

在运行时添加或移除传输器：

```ts
log.addTransport(httpTransport);
log.removeTransport('http');
```
