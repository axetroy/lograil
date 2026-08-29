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

### RotatingFileTransport

面向 Node.js 与 Electron 主进程、带滚动能力的文件传输器。

```ts
import { RotatingFileTransport, createJsonFormatter } from 'lograil';

new RotatingFileTransport({
  path: '/var/log/app.log',
  daily: true, // 默认：每天一个带日期的文件
  maxFiles: 99, // 每日环形缓冲大小（默认 99 / 体积模式 5）
  maxSize: 10 * 1024 * 1024, // 体积模式的阈值（仅体积模式）
  formatter: createJsonFormatter(),
});
```

- **每日模式**（默认）：活动文件为 `app.{YYYY-MM-DD}.{01..maxFiles}.log`。当索引将要超过 `maxFiles` 时回绕到 `01` 并清空该文件——形成一个按天的环形缓冲。
- **体积模式**（`daily: false`）：经典的分代滚动 `app.log` → `app.1.log` → `app.2.log` …，当活动文件超过 `maxSize` 时触发。

利用 `filter` 选项可以把单个 logger 的输出拆分到多个文件。内置的 Electron 主进程运行时正是用它来把主进程日志（`main.{date}.{idx}.log`）与渲染进程日志（`renderer.{date}.{idx}.log`）分开：

```ts
import { RotatingFileTransport, createJsonFormatter } from 'lograil';

// 只接收渲染进程条目（由 IPC 桥接在 metadata 中打标）。
new RotatingFileTransport({
  path: '/var/log/renderer.log',
  daily: true,
  filter: (e) => e.metadata?.renderer === 'renderer',
  formatter: createJsonFormatter(),
});
```

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
