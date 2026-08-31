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
}
```

`level` 会在 logger 级别过滤之外，单独限制该传输器：低于它的日志仅会被此 sink 跳过。可用它拆分日志流——例如把 `error` 及以上发往远端，其余写入文件。


## ConsoleTransport

```ts
interface ConsoleTransportOptions {
  name?: string;
  formatter?: Formatter;
  methodMap?: Partial<Record<string, (...args: unknown[]) => void>>;
  /** 路由到 `console.error`（stderr）的级别。默认为空——内置 `methodMap` 已把
   * `error`/`fatal` 发往 stderr；可在此追加 `'warn'` 等。 */
  stderrLevels?: LogLevelName[];
}

class ConsoleTransport implements Transport;
```

将每个级别映射到某个 `console` 方法（可通过 `methodMap` 覆盖）。列在 `stderrLevels` 中的级别会被额外路由到 `console.error`（stderr）——便于把 warning/error 引到单独的流。

## FileTransport

```ts
interface FileBaseOptions {
  appName: string; // 必填；日志文件名始终包含它
  dir?: string; // 默认 os.tmpdir()
  formatter?: Formatter;
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
  maxFiles: number; // 必填；保留多少代
  ext?: string;
}

// 2.2 — 按时间轮转；文件名是时间戳的函数
interface RotateTimeOptions extends FileBaseOptions {
  mode: 'rotate-time';
  unit: 'hour' | 'day'; // 必填
  maxFiles?: number; // 可选：时间桶（stamp）上限，按桶计数而非按文件
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
  maxFiles?: number;
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

当 `ipcRenderer.postMessage` 可用时，传输器会把条目一次性序列化为 `ArrayBuffer`，
并**转移**其所有权跨进程（零拷贝），而非让 Electron 对整棵对象图做结构化克隆。
旧版 `send` 路径作为回退保留。主进程侧用 `registerIpcReceiver` 解码（并标记为
渲染进程来源）。参见[不可变性与零拷贝](../guide/immutability.md)。

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
}

class OtlpTransport implements Transport;
```

通过 OTLP HTTP/JSON（`POST /v1/logs`）把日志转发到 OpenTelemetry Collector。日志会被缓冲并按批次发送；调用 `logger.flush()`（或开启 `autoFlushOnExit`）即可排空。需要全局 `fetch`（Node >= 18、现代浏览器、Electron 均支持）。

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
零拷贝的 `LogEntry`。当 `bufferSize > 0` 时，后加入的订阅者可用 `replay()` 回放
环形缓冲。详见[传输器指南](/zh/guide/transports#livetransport)。
