# 传输器

## Transport 接口

```ts
interface Transport {
  readonly name: string;
  readonly formatter?: Formatter;
  write(entry: LogEntry, formatted: string): void | Promise<void>;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

## ConsoleTransport

```ts
interface ConsoleTransportOptions {
  name?: string;
  formatter?: Formatter;
  methodMap?: Partial<Record<string, (...args: unknown[]) => void>>;
}

class ConsoleTransport implements Transport;
```

将每个级别映射到某个 `console` 方法（可通过 `methodMap` 覆盖）。

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
