# 传输器

## Transport 接口

```ts
interface Transport {
  readonly name: string;
  readonly formatter?: Formatter;
  readonly level?: LogLevelInput; // 可选的传输器最小级别
  write(entry: LogEntry, formatted: string): void | Promise<void>;
  onError?(err: unknown, entry: LogEntry): void; // write 失败时由 logger 调用
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
  /**
   * 异步写入队列的最大深度。超出时最新条目被丢弃，并调用 `onOverflow`。
   * `0` 表示使用全局 {@link LoggerOptions.maxQueueDepth}。默认 `0`。
   */
  queueLimit?: number;
  /** 当该传输器队列已满、条目被丢弃时回调。 */
  onOverflow?(entry: LogEntry, queueDepth: number): void;
}
```

`level` 会在 logger 级别过滤之外，单独限制该传输器：低于它的日志仅会被此 sink 跳过。可用它拆分日志流——例如把 `error` 及以上发往远端，其余写入文件。

onError 不仅在 write() 失败时被调用，FileTransport 还会通过它上报内部
文件系统错误，例如轮转失败或备份删除失败。这些错误不会中断传输器运行——
你可以在 onError 中记录日志、上报指标或发出告警。

## ConsoleTransport

```ts
interface ConsoleTransportOptions {
  name?: string;
  formatter?: Formatter; // 默认 createLineFormatter()
  methodMap?: Partial<Record<string, (...args: unknown[]) => void>>;
  /** 路由到 `console.error`（stderr）的级别。默认为空——内置 `methodMap` 已把
   * `error`/`fatal` 发往 stderr；可在此追加 `'warn'` 等。 */
  stderrLevels?: LogLevelName[];
}

class ConsoleTransport implements Transport;
```

将每个级别映射到某个 `console` 方法（可通过 `methodMap` 覆盖）。列在 `stderrLevels` 中的级别会被额外路由到 `console.error`（stderr）——便于把 warning/error 引到单独的流。模块加载时会用 `typeof console` 保护捕获真实的 `console` 方法，因此在不提供全局 `console` 的精简运行时中导入 lograil 也不会抛错。

## FileTransport

```ts
interface FileBaseOptions {
  appName: string; // 必填；日志文件名始终包含它
  dir?: string; // 默认 os.tmpdir()
  formatter?: Formatter; // 默认 createLineFormatter()
  filter?: (entry: LogEntry) => boolean; // 返回 false 时丢弃该条目
  name?: string; // 传输器名，用于诊断与 removeTransport；默认 `file:<appName>`（不参与文件名）
  /** 所有文件（活动 + 历史）的总体积上限。默认 Infinity。 */
  maxTotalSize?: number;
  /** 
   * 文件最大存活毫秒数。
   * - `undefined` 或 `-1`（默认）：不限制。
   * - `0`：立即删除所有历史文件。
   * - `>0`：毫秒数阈值。
   */
  maxAge?: number;
}

// 1.1 — 单文件，一直追加到磁盘满
interface SingleFileOptions extends FileBaseOptions {
  mode: 'single';
  ext?: string; // 默认 'log'
}

// 1.2 — 单文件；超出 maxSize 时备份后原地截断
interface SingleTruncateOptions extends FileBaseOptions {
  mode: 'single-truncate';
  maxSize: number; // 必填
  backupName?: string; // 备份文件名；默认 `${appName}.bak`
  ext?: string;
}

// 2.1 — 按体积轮转；文件名是代际序号的函数
interface RotateSizeOptions extends FileBaseOptions {
  mode: 'rotate-size';
  maxSize: number; // 必填
  maxFiles: number; // 必填；保留多少代（1=仅活动文件，<=0=不限制）
  ext?: string;
}

// 2.2 — 按时间轮转；文件名是时间戳的函数
interface RotateTimeOptions extends FileBaseOptions {
  mode: 'rotate-time';
  unit: 'hour' | 'day'; // 必填
  maxFiles?: number; // 可选：时间桶（stamp）上限（1=仅最新桶，<=0/未设=不限制）
  maxSize?: number; // 可选：同一时间桶内超过此大小时自动拆分
  maxFilesPerBucket?: number; // 可选：单个时间桶内最多保留多少个 seq 文件（桶内成环）
  now?: () => Date; // 时钟覆盖（用于测试）
  ext?: string;
}

// 2.3 — 自定义何时轮转；文件名是序号的函数
interface RotateCustomOptions extends FileBaseOptions {
  mode: 'rotate-custom';
  shouldRotate: (entry: LogEntry, ctx: RotateContext) => boolean; // 必填
  fileName: (app: string, seq: number, ext: string) => string; // 必填
  maxFiles?: number; // 可选：1=仅活动文件，<=0/未设=不限制
  ext?: string;
}

type FileTransportOptions =
  | SingleFileOptions
  | SingleTruncateOptions
  | RotateSizeOptions
  | RotateTimeOptions
  | RotateCustomOptions;

class FileTransport implements Transport;
```

`FileTransport` 取代了旧的 `RotatingFileTransport`。`appName` 必填，且始终是文件名的一部分，因此日志文件可以按所属应用识别。可选的 `name` 与之无关——它只给传输器实例打标签，用于诊断和 `removeTransport()`，默认 `file:<appName>`，不会出现在文件名里。模式是一个判别联合——选一种模式，就只有该模式的字段是必填的，绝不会忘记所选模式需要的参数。

### 查看和获取日志文件

```ts
interface FileMeta {
  name: string;       // 文件名，如 myapp.2026-09-01.0.log
  path: string;       // 绝对路径
  size: number;       // 字节数
  mtime: number;      // 最后修改时间戳（毫秒）
  active: boolean;    // 是否当前正在写入的文件
}

interface GetFilesOptions {
  /** 只返回本次实例创建的文件（排除旧文件），默认 false */
  currentSessionOnly?: boolean;
}

class FileTransport {
  /** 日志目录的绝对路径 */
  getDir(): string;

  /** 当前正在写入的文件路径 */
  getActiveFile(): string;

  /** 列出所有日志文件（包括旧文件） */
  getFiles(options?: GetFilesOptions): Promise<FileMeta[]>;
}
```

`getFiles()` 默认返回该 transport 管理的所有文件，包括启动时从磁盘扫描到的历史文件。传入 `{ currentSessionOnly: true }` 可以只返回本次 transport 实例创建的文件。

通过 `instanceof FileTransport` 可以从 `logger.getTransports()` 中找到 FileTransport 实例：

```ts
import { logger, FileTransport } from 'lograil';

const ft = logger.getTransports()
  .find((t): t is FileTransport => t instanceof FileTransport);

if (ft) {
  const files = await ft.getFiles();
  // ...业务逻辑
}
```

> **仅 Node / Electron 主进程可用。** `FileTransport` 使用真实的 `node:fs` API 写入。
> 在浏览器打包中，其 fs 函数被替换为调用即抛错的 stub——**引入是安全的**，但在浏览器中写文件会失败。
> Web 端请使用控制台或远程传输器（或 `createWebRuntime()`）。

- `single` — 单个 `dir/<appName>.<ext>` 文件，一直追加（直到磁盘写满）。
- `single-truncate` — 同样是单文件，但一旦即将超过 `maxSize`，当前内容被改名为 `backupName`，原文件原地截断（环形缓冲）。一个主文件加一个备份。
- `rotate-size` — 当 `size + bytes > maxSize` 时，按 `maxFiles` 推移代际（`app.log` → `app.1.log` → …），归档名遵循默认的 `${app}.${seq}.${ext}`。
- `rotate-time` — 在每个 `unit` 边界（`hour`/`day`）开启新文件，并以时间戳命名（`${app}.${stamp}.${seq}.${ext}`）。设置 `maxSize` 后，同一时间桶内的文件会按体积拆分（如 `app.2026-08-31.0.log`、`app.2026-08-31.1.log`）。`maxFiles` 按**时间桶**计数，而非按文件——删除某个桶时，其下所有 seq 文件一并删除。`maxFilesPerBucket` 限制**单个桶内**的 seq 文件数，超出时删除桶内最旧的（桶内成环，活动文件永不删除）。三者组合后磁盘占用上界约为 `maxFiles × maxFilesPerBucket × maxSize` 字节。
- `rotate-custom` — `shouldRotate(entry, ctx)` 决定何时切分；`fileName(app, seq, ext)` 为每个文件命名。对轮转拥有完全控制。

所有模式共用同一套 `open`/`queue`/`mkdir`/`flush`/`close` 机制，仅在\"何时切换、下一个文件如何命名\"上各模式不同。

## ElectronIpcTransport

```ts
interface ElectronIpcTransportOptions {
  channel?: string;
  name?: string;
}

class ElectronIpcTransport implements Transport;
```

渲染进程侧：通过 IPC 将每条条目转发到主进程。在 Electron 之外导入也是安全的。

传输器使用 `ipcRenderer.send()` 进行跨进程通信，Electron 内部会自动对消息做结构化克隆。
主进程侧用 `registerIpcReceiver` 接收并处理（同时标记为渲染进程来源）。
参见[不可变性](../guide/immutability.md)。

## WorkerIpcTransport

```ts
interface WorkerIpcTransportOptions {
  name?: string;
}
class WorkerIpcTransport implements Transport {
  readonly name: string;
  onError?: (err: unknown, entry: LogEntry) => void;
  write(entry: LogEntry, _formatted: string): void;
  /** 向主线程 / 父线程转发一条跨进程级别命令。 */
  sendLevelCommand(level: number): void;
  close(): void; // 空操作；Worker 生命周期由 Worker 实例自身管理
}
function registerWorkerReceiver(
  ingest: (entry: LogEntry) => void,
  options?: WorkerReceiverOptions & { onLevelCommand?: (level: number) => void },
): () => void;
```

Worker 侧传输器：通过 `self.postMessage()` 把每条条目转发到主线程 / 父线程。
在非 Worker 环境导入是安全的——`self.postMessage` 不可用时 `write` 为空操作。
主线程侧用 `registerWorkerReceiver` 解码条目，并把级别命令转发给
`onLevelCommand`。传入显式 `worker` 实例且该实例使用单槽位 `onmessage`
属性时，原有的处理函数会被保存并由返回的取消注册函数恢复，避免被静默覆盖。
断路器（连续 10 次失败 → 5 秒窗口）会在主线程死亡时抑制逐条报错，同时每次
写入仍尝试投递，因此通道恢复后自动继续工作。

## ClusterIpcTransport

```ts
interface ClusterIpcTransportOptions {
  channel?: string; // IPC 通道名，默认 'lograil:cluster:log'
  name?: string;
}
class ClusterIpcTransport implements Transport {
  readonly name: string;
  onError?: (err: unknown, entry: LogEntry) => void;
  write(entry: LogEntry, _formatted: string): void;
  /** 向主进程转发一条跨进程级别命令。 */
  sendLevelCommand(level: number): void;
  close(): void; // 空操作；cluster 模块管理 worker 生命周期
}
function registerClusterReceiver(
  ingest: (entry: LogEntry) => void,
  options?: ClusterReceiverOptions & { onLevelCommand?: (level: number) => void },
): () => void;
```

Cluster worker 侧传输器：通过 `process.send()` 把每条条目转发到主进程。
在非 cluster worker 环境导入是安全的——`process.send` 不可用时 `write` 为
空操作。主进程侧用 `registerClusterReceiver` 解码条目，并把级别命令转发给
`onLevelCommand`。断路器（连续 5 次失败 → 5 秒窗口）会在主进程死亡时抑制
逐条报错。

## OtlpTransport

```ts
interface OtlpTransportOptions {
  endpoint?: string; // 默认 http://localhost:4318/v1/logs
  headers?: Record<string, string>;
  resource?: Record<string, unknown>;
  serviceName?: string; // 默认 'lograil'
  scopeName?: string; // 默认 'lograil'
  batchSize?: number; // 默认 100
  formatter?: Formatter; // 接口对齐用；OTLP 实际自行序列化条目
  onError?: (err: unknown) => void;
  /**
   * 瞬态失败（网络错误或 5xx）后的最大重试次数。失败尝试在原地以指数退避重试。
   * 最后一次尝试仍未能投递（或被 4xx 直接拒绝）的 batch 会递增 {@link dropCount}；
   * 其记录集合会被记住，供下一次 `flush()` / `close()` 再投递一次，之后永久丢弃——
   * 因此一个始终失败的端点每个 batch 最多消耗两个 flush 周期。默认 `3`。
   * 设为 `0` 则禁用 batch 内重试（每次尝试快速失败）。
   */
  maxRetries?: number;
  /**
   * 首次重试前的初始退避延迟（毫秒）。每次重试翻倍，上限为 {@link retryMaxDelayMs}。默认 `250`。
   */
  retryInitialDelayMs?: number;
  /**
   * 退避延迟上限（毫秒）。默认 `5000`。
   */
  retryMaxDelayMs?: number;
  /**
   * 内部缓冲区可容纳的最大条目数，超出后丢弃最新条目。`0` 表示不限制。默认 `10_000`。
   */
  maxQueueSize?: number;
  /** 当达到 `maxQueueSize` 导致条目被丢弃时调用。 */
  onQueueOverflow?: (entry: LogEntry, queueDepth: number) => void;
}

class OtlpTransport implements Transport {
  /** 因队列溢出而丢弃的总条目数。 */
  readonly overflowDropCount: number;
  /** 缓冲区中等待发送的当前条目数。 */
  readonly bufferLength: number;
  /** 重试耗尽后未能投递的记录数。 */
  readonly dropCount: number;
}
```

通过 OTLP HTTP/JSON（`POST /v1/logs`）把日志转发到 OpenTelemetry Collector。日志会被缓冲并按批次发送；调用 `logger.flush()`（或开启 `autoFlushOnExit`）即可排空。需要全局 `fetch`（Node >= 18、现代浏览器、Electron 均支持）。

由于 `write()` 是同步的，Logger 层的通用 `queueLimit` / `onOverflow` **不会**对 OTLP 生效。请使用 `maxQueueSize` / `onQueueOverflow` 控制 OTLP 的背压行为。

## registerIpcReceiver

```ts
function registerIpcReceiver(
  ingest: (entry: LogEntry) => void,
  options?: { channel?: string },
): () => void;
```

主进程侧的辅助函数：监听 IPC 频道，并将渲染进程发来的条目喂给 `ingest`（通常是 `logger.ingestEntry`）。返回用于取消注册的函数。

```ts
import { registerIpcReceiver } from 'lograil';

const off = registerIpcReceiver((entry) => logger.ingestEntry(entry));
```

## LiveTransport

```ts
interface LiveTransportOptions {
  name?: string;
  formatter?: Formatter; // 供 onFormatted 使用；否则给原始条目
  bufferSize?: number; // 供 replay() 使用的环形缓冲大小；0 关闭（默认）
}

class LiveTransport implements Transport {
  readonly name: string;
  readonly formatter?: Formatter;
  get subscriberCount(): number;
  subscribe(cb: (entry: LogEntry) => void): () => void; // 返回取消订阅函数
  onFormatted(cb: (line: string, entry: LogEntry) => void): () => void;
  replay(cb: (entry: LogEntry) => void, newestFirst?: boolean): number; // 数量
  clearBuffer(): void;
  close(): void;
}
```

用于实时日志流的内存型、可订阅传输器。`write()` 把每条条目转发给所有订阅者，
并捕获订阅者抛出的异常，使 logger 的热路径永不被打断。订阅者拿到的是已冻结、
 `LogEntry`。当 `bufferSize > 0` 时，后加入的订阅者可用 `replay()` 回放
环形缓冲。详见[传输器指南](/zh/guide/transports#livetransport)。

## BroadcastChannelTransport

```ts
interface BroadcastChannelTransportOptions {
  name?: string;           // BroadcastChannel 名称，默认 'lograil'
  transportName?: string;  // Transport.name，默认 'broadcast-channel'
  formatter?: Formatter;
}
class BroadcastChannelTransport implements Transport {
  readonly name: string;
  readonly formatter: Formatter;
  onError?: (err: unknown, entry: LogEntry) => void;
  /** 订阅本频道从其他标签页收到的条目。 */
  subscribe(cb: (entry: LogEntry) => void): () => void;
  write(entry: LogEntry, formatted: string): void;
  close(): void;
}
function registerBroadcastChannelReceiver(
  ingest: (entry: LogEntry) => void,
  options?: { name?: string; transportName?: string },
): () => void;
```

跨标签页 / 跨窗口的 Web 流式传输。每个 `addTransport` 了它的标签页会把每条
条目广播到一个共享的 `BroadcastChannel`；同一来源、相同频道名的其他标签页
通过 `subscribe`（或 `registerBroadcastChannelReceiver`）收到它。可在任意
运行时导入——在没有 `BroadcastChannel` 的平台（Node、Electron 主进程、旧
浏览器）上 `write` 为空操作，订阅者永不被调用。

## OS 原生传输器

三个传输器把记录交给操作系统自身的日志栈。每个都可在任意运行时中导入，
且在模块加载时绝不抛错；在缺少对应二进制 / 设施时，传输器降级到 `onError`
路径，并用断路器限制，避免损坏的 sink 刷爆控制台。

```ts
interface SyslogTransportOptions {
  name?: string;
  formatter?: Formatter;
  facility?: number;      // RFC 5424 设施，默认 3（LOG_DAEMON）
  protocol?: 'local' | 'udp';  // 'local' = logger 二进制，'udp' = 原始数据报
  host?: string;          // udp 模式，默认 'localhost'
  port?: number;          // udp 模式，默认 514
  tag?: string;           // logger -t tag，默认取传输器名
  loggerPath?: string;    // 覆盖二进制位置
}
class SyslogTransport implements Transport { /* name, formatter, write, close, onError */ }

interface JournaldTransportOptions {
  name?: string;
  formatter?: Formatter;
  fields?: Record<string, string>;  // 固定的 KEY=VALUE 日志字段（IDENTIFIER 默认取名称）
  priority?: number;                // 固定的 PRIORITY 日志字段
}
class JournaldTransport implements Transport { /* name, formatter, write, close, onError */ }

interface WindowsEventLogTransportOptions {
  name?: string;
  formatter?: Formatter;
  log?: string;       // 目标事件日志，默认取传输器名
  source?: string;    // 提供方 / 来源字符串，默认取传输器名
  eventId?: number;   // 默认记录 ID，默认 1
}
class WindowsEventLogTransport implements Transport { /* name, formatter, write, close, onError */ }
```

- **`SyslogTransport`** — Unix，经 `logger`（`protocol: 'local'`）或原始 UDP
  数据报（`protocol: 'udp'`，经 `nc`）。
- **`JournaldTransport`** — Linux/systemd，经一个常驻的 `systemd-cat`；
  `fields` 成为固定的日志字段。
- **`WindowsEventLogTransport`** — Windows，经 `eventcreate.exe`；可通过
  `entry.metadata.wevtid` 按条目覆盖事件 ID。

三者共用级别 → syslog 优先级映射（`trace`/`debug`→7，`info`→6，`warn`→4，
`error`→3，`fatal`→2）。平台门控：Unix 传输器需要对应二进制；Windows
传输器需要 `win32`。在浏览器构建中，三者都降级为不可用的 `onError` 路径。
详见[传输器指南](/zh/guide/transports#os-原生传输器)。
