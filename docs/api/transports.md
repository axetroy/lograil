# Transports

## Transport interface

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

Maps each level to a `console` method (override via `methodMap`).

## RotatingFileTransport

```ts
interface RotatingFileTransportOptions {
  path: string; // e.g. '/var/log/app.log'
  maxSize?: number; // size-mode threshold (bytes)
  maxFiles?: number; // ring buffer size (daily default 99, size default 5)
  daily?: boolean; // default true
  now?: () => Date; // clock override (testing)
  formatter?: Formatter;
  name?: string;
}

class RotatingFileTransport implements Transport;
```

See [Transports guide](/guide/transports) for rotation behavior.

## ElectronIpcTransport

```ts
interface ElectronIpcTransportOptions {
  channel?: string;
  name?: string;
}

class ElectronIpcTransport implements Transport;
```

Renderer-side: forwards each entry to the main process over IPC. Safe to import
outside Electron.

## registerIpcReceiver

```ts
function registerIpcReceiver(
  ingest: (entry: LogEntry) => void,
  options?: { channel?: string },
): () => void;
```

Main-side helper that listens on the IPC channel and feeds renderer entries into
`ingest` (typically `logger.ingestEntry`). Returns an unregister function.

```ts
import { registerIpcReceiver } from 'lograil';

const off = registerIpcReceiver((entry) => logger.ingestEntry(entry));
```
