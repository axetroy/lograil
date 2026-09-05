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
  /**
   * Max pending async-write queue depth. When exceeded, the newest entry is
   * dropped and `onOverflow` is called. `0` means "use the global
   * {@link LoggerOptions.maxQueueDepth} instead". Default `0`.
   */
  queueLimit?: number;
  /** Called when this transport's queue is full and an entry is dropped. */
  onOverflow?(entry: LogEntry, queueDepth: number): void;
}
```

`level` restricts this transport independently of the logger-level filter: entries
below it are skipped by this sink only. Use it to split streams — e.g. send
`error` and above to a remote sink while writing everything to a file.

`onError` is called when `write()` fails, but also by `FileTransport` for internal
filesystem errors such as failed rotations or backup deletions. These are
non-fatal — the transport keeps running — but you can use `onError` to surface
them via logging, metrics, or alerts.

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
  name?: string; // transport name for diagnostics & removeTransport; default `file:<appName>` (never part of file names)
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

// 2.1 — roll by size; file name is a function of the generation seq
interface RotateSizeOptions extends FileBaseOptions {
  mode: 'rotate-size';
  maxSize: number; // required
  maxFiles: number; // required; generations to keep (1 = active only, <=0 = unlimited)
  ext?: string;
}

// 2.2 — roll by time; file name is a function of the timestamp
interface RotateTimeOptions extends FileBaseOptions {
  mode: 'rotate-time';
  unit: 'hour' | 'day'; // required
  maxFiles?: number; // optional: cap on time buckets (1 = newest bucket only, <=0/undefined = unlimited)
  maxSize?: number; // optional: split within the same time bucket when exceeded
  maxFilesPerBucket?: number; // optional: max seq files kept within one time bucket (inner ring)
  now?: () => Date; // clock override (testing)
  ext?: string;
}

// 2.3 — roll whenever your predicate says so; file name is a function of the sequence
interface RotateCustomOptions extends FileBaseOptions {
  mode: 'rotate-custom';
  shouldRotate: (entry: LogEntry, ctx: RotateContext) => boolean; // required
  fileName: (app: string, seq: number, ext: string) => string; // required
  maxFiles?: number; // optional: 1 = active only, <=0/undefined = unlimited
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
application. The optional `name` is separate — it only labels the transport
instance for diagnostics and `removeTransport()`, defaults to `file:<appName>`,
and never appears in file names. The mode is a discriminated union — pick one and only its fields are
required, so you can never forget a parameter the chosen mode needs.

### Listing and inspecting log files

```ts
interface FileMeta {
  name: string;       // e.g. myapp.2026-09-01.0.log
  path: string;       // absolute path
  size: number;       // bytes
  mtime: number;      // last modification timestamp (ms)
  active: boolean;    // whether this is the currently active file
}

interface GetFilesOptions {
  /** Only return files created by this transport instance (excludes old files). Default false. */
  currentSessionOnly?: boolean;
}

class FileTransport {
  /** Absolute path of the log directory. */
  getDir(): string;

  /** Absolute path of the file currently being written to. */
  getActiveFile(): string;

  /** List all log files managed by this transport (including old files). */
  getFiles(options?: GetFilesOptions): Promise<FileMeta[]>;
}
```

`getFiles()` returns all files managed by this transport, including old files
found on disk when the transport started. Pass `{ currentSessionOnly: true }` to
only return files created by the current transport instance.

Find the `FileTransport` instance from the default singleton using `instanceof`:

```ts
import { logger, FileTransport } from 'lograil';

const ft = logger.getTransports()
  .find((t): t is FileTransport => t instanceof FileTransport);

if (ft) {
  const files = await ft.getFiles();
  // ... business logic
}
```

> **Node / Electron main only.** `FileTransport` writes with the real `node:fs`
> API. In a browser bundle its fs functions are replaced by a stub that throws
> on use — importing is safe, but writing a file in the browser is not. Use a
> console or remote transport (or `createWebRuntime()`) on the Web.

- `single` — one `dir/<appName>.<ext>` file, appended forever (until the disk fills).
- `single-truncate` — same single file, but once `maxSize` would be exceeded the
  current content is renamed to `backupName` and the original is truncated (ring
  buffer). One main file plus one backup.
- `rotate-size` — when `size + bytes > maxSize`, shift generations
  (`app.log` → `app.1.log` → …) via `maxFiles`; archived names follow the
  default `${app}.${seq}.${ext}` pattern.
- `rotate-time` — at each `unit` boundary (`hour`/`day`) a new file is opened and
  named with a timestamp (`${app}.${stamp}.${seq}.${ext}`).
  When `maxSize` is set, files within the same time bucket are split by size
  (e.g. `app.2026-08-31.0.log`, `app.2026-08-31.1.log`). `maxFiles` counts
  **time buckets**, not individual files — when a bucket is trimmed, all its
  seq files are deleted together. `maxFilesPerBucket` caps the number of seq
  files **within one bucket** — the oldest are deleted (the bucket forms an
  inner ring; the active file is never deleted). Combined, the three options
  bound total disk usage at roughly `maxFiles × maxFilesPerBucket × maxSize`
  bytes.
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

Renderer-side: forwards each entry to the main process over IPC via
`ipcRenderer.send()`, relying on Electron's structured cloning.
Safe to import outside Electron. Decode on the main side with
`registerIpcReceiver` (which also tags entries as renderer-origin).

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
  /**
   * Max retry attempts after a transient failure (network error or 5xx).
   * Each failed attempt is re-queued and retried with exponential backoff.
   * On exhaustion the batch is dropped and {@link dropCount} increments.
   * Default `3`. Set to `0` to disable retries entirely (fail fast).
   */
  maxRetries?: number;
  /**
   * Initial backoff delay in ms before the first retry. Doubles after each
   * retry, capped at {@link retryMaxDelayMs}. Default `1000`.
   */
  retryInitialDelayMs?: number;
  /**
   * Maximum backoff delay in ms. Default `30000`.
   */
  retryMaxDelayMs?: number;
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
