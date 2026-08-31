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

## FileTransport

```ts
interface FileBaseOptions {
  appName: string; // required; the log file name always contains it
  dir?: string; // default os.tmpdir()
  formatter?: Formatter;
  filter?: (entry: LogEntry) => boolean; // drop entries when it returns false
  name?: string;
  /** Global cap on total bytes of all owned files (active + history). Default Infinity. */
  maxTotalSize?: number;
  /** 
   * Global cap on file age in ms.
   * - `undefined` or `-1` (default): no limit.
   * - `0`: delete all history files immediately.
   * - `>0`: threshold in milliseconds.
   */
  maxAge?: number;
}

// 1.1 — single fixed file, append until the disk is full
interface SingleFileOptions extends FileBaseOptions {
  mode: 'single';
  ext?: string; // default 'log'
}

// 1.2 — single file; when maxSize is exceeded, back up then truncate in place
interface SingleTruncateOptions extends FileBaseOptions {
  mode: 'single-truncate';
  maxSize: number; // required
  backupName?: string; // backup file name; default `${appName}.bak`
  ext?: string;
}

// 2.1 — roll by size; file name is a function of the generation index
interface RotateSizeOptions extends FileBaseOptions {
  mode: 'rotate-size';
  maxSize: number; // required
  maxFiles: number; // required; how many generations to keep
  fileName?: (app: string, index: number, ext: string) => string; // default `${app}.${index}.${ext}`
  ext?: string;
}

// 2.2 — roll by time; file name is a function of the timestamp
interface RotateTimeOptions extends FileBaseOptions {
  mode: 'rotate-time';
  unit: 'hour' | 'day'; // required
  maxFiles?: number; // optional ring cap
  now?: () => Date; // clock override (testing)
  fileName?: (app: string, stamp: string, ext: string) => string; // default `${app}.${stamp}.${ext}`
  ext?: string;
}

// 2.3 — roll whenever your predicate says so; file name is a function of the sequence
interface RotateCustomOptions extends FileBaseOptions {
  mode: 'rotate-custom';
  shouldRotate: (entry: LogEntry, ctx: RotateContext) => boolean; // required
  fileName: (app: string, seq: number, ext: string) => string; // required
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

`FileTransport` replaces the old `RotatingFileTransport`. `appName` is required and
is always part of the file name, so a log file is identifiable by its owning
application. The mode is a discriminated union — pick one and only its fields are
required, so you can never forget a parameter the chosen mode needs.

> **Node / Electron main only.** `FileTransport` writes with the real `node:fs`
> API. In a browser bundle its fs functions are replaced by a stub that throws
> on use — importing is safe, but writing a file in the browser is not. Use a
> console or remote transport (or `createWebRuntime()`) on the Web.

- `single` — one `dir/<appName>.<ext>` file, appended forever (until the disk fills).
- `single-truncate` — same single file, but once `maxSize` would be exceeded the
  current content is renamed to `backupName` and the original is truncated (ring
  buffer). One main file plus one backup.
- `rotate-size` — when `size + bytes > maxSize`, shift generations
  (`app.log` → `app.1.log` → …) via `maxFiles`; `fileName(app, index, ext)` lets
  you shape the archived names.
- `rotate-time` — at each `unit` boundary (`hour`/`day`) a new file is opened and
  named with a timestamp; `fileName(app, stamp, ext)` controls the shape.
- `rotate-custom` — `shouldRotate(entry, ctx)` decides when to cut; `fileName(app,
  seq, ext)` names every file. Total control over rotation.

All modes share the same `open`/`queue`/`mkdir`/`flush`/`close` plumbing; only the
"when do we switch, and how is the next file named" logic differs per mode.

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
