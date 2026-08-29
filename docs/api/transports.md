# Transports

## Transport interface

```ts
interface Transport {
  readonly name: string;
  readonly formatter?: Formatter;
  readonly level?: LogLevelInput; // optional per-transport minimum level
  write(entry: LogEntry, formatted: string): void | Promise<void>;
  onError?(err: unknown, entry: LogEntry): void; // called by the logger if write fails
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

`level` restricts this transport independently of the logger-level filter: entries
below it are skipped by this sink only. Use it to split streams — e.g. send
`error` and above to a remote sink while writing everything to a file.


## ConsoleTransport

```ts
interface ConsoleTransportOptions {
  name?: string;
  formatter?: Formatter;
  methodMap?: Partial<Record<string, (...args: unknown[]) => void>>;
  /** Levels routed to `console.error` (stderr). Defaults to empty — the built-in
   * `methodMap` already sends `error`/`fatal` to stderr; add `'warn'` etc. here. */
  stderrLevels?: LogLevelName[];
}

class ConsoleTransport implements Transport;
```

Maps each level to a `console` method (override via `methodMap`). Levels listed in
`stderrLevels` are additionally routed to `console.error` (stderr) — useful for
piping warnings/errors to a separate stream.

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
  /**
   * Optional per-entry predicate. When it returns `false` the entry is dropped
   * (not written). Handy for splitting one logger's output across multiple files
   * — e.g. main vs renderer process logs, or an error-only vs full archive.
   */
  filter?: (entry: LogEntry) => boolean;
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

When `ipcRenderer.postMessage` is available the transport serialises the entry
once into an `ArrayBuffer` and **transfers** it across the process boundary
(zero-copy) instead of letting Electron structured-clone the whole object graph.
The legacy `send` path is used as a fallback. Decode on the main side with
`registerIpcReceiver` (which also tags entries as renderer-origin). See
[Immutability & zero-copy](../guide/immutability.md).

## OtlpTransport

```ts
interface OtlpTransportOptions {
  endpoint?: string; // default http://localhost:4318/v1/logs
  headers?: Record<string, string>;
  resource?: Record<string, unknown>;
  serviceName?: string; // default 'lograil'
  scopeName?: string; // default 'lograil'
  batchSize?: number; // default 100
  formatter?: Formatter; // interface parity; OTLP serializes the entry itself
  onError?: (err: unknown) => void;
}

class OtlpTransport implements Transport;
```

Forwards entries to an OpenTelemetry Collector over OTLP HTTP/JSON (`POST
/v1/logs`). Entries are buffered and sent in batches; call `logger.flush()` (or
enable `autoFlushOnExit`) to drain them. Requires a global `fetch` (Node >= 18,
modern browsers, Electron).

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

## LiveTransport

```ts
interface LiveTransportOptions {
  name?: string;
  formatter?: Formatter; // used by onFormatted; raw entries otherwise
  bufferSize?: number; // ring-buffer size for replay(); 0 disables (default)
}

class LiveTransport implements Transport {
  readonly name: string;
  readonly formatter?: Formatter;
  get subscriberCount(): number;
  subscribe(cb: (entry: LogEntry) => void): () => void; // returns unsubscribe
  onFormatted(cb: (line: string, entry: LogEntry) => void): () => void;
  replay(cb: (entry: LogEntry) => void, newestFirst?: boolean): number; // count
  clearBuffer(): void;
  close(): void;
}
```

In-memory, subscribable transport for live log streaming. `write()` forwards each
entry to all subscribers and catches subscriber errors so the logger's hot path
never breaks. Subscribers receive the frozen, zero-copy `LogEntry`. With
`bufferSize > 0`, late subscribers can `replay()` the ring buffer. See
[Transports guide](/guide/transports#livetransport).
