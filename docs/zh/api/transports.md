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

## RotatingFileTransport

```ts
interface RotatingFileTransportOptions {
  path: string; // 例如 '/var/log/app.log'
  maxSize?: number; // 体积模式阈值（字节）
  maxFiles?: number; // 环形缓冲大小（每日默认 99，体积默认 5）
  daily?: boolean; // 默认 true
  now?: () => Date; // 时钟覆盖（用于测试）
  formatter?: Formatter;
  name?: string;
  /**
   * 可选的按条目谓词。返回 `false` 时该条目被丢弃（不写入）。便于把单个 logger 的
   * 输出拆分到多个文件——例如主进程与渲染进程日志，或"仅错误"与"完整归档"。
   */
  filter?: (entry: LogEntry) => boolean;
}

class RotatingFileTransport implements Transport;
```

滚动行为详见 [传输器指南](/zh/guide/transports)。

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
