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
  formatter?: Formatter; // default createLineFormatter()
  methodMap?: Partial<Record<string, (...args: unknown[]) => void>>;
  /** Levels routed to `console.error` (stderr). Defaults to empty — the built-in
   * `methodMap` already sends `error`/`fatal` to stderr; add `'warn'` etc. here. */
  stderrLevels?: LogLevelName[];
}

class ConsoleTransport implements Transport;
```

Maps each level to a `console` method (override via `methodMap`). Levels listed in
`stderrLevels` are additionally routed to `console.error` (stderr) — useful for
piping warnings/errors to a separate stream. The real `console` methods are
captured at module load with a `typeof console` guard, so importing lograil in a
minimal runtime that does not expose a global `console` does not throw.

## FileTransport

```ts
interface FileBaseOptions {
  appName: string; // required; the log file name always contains it
  dir?: string; // default os.tmpdir()
  formatter?: Formatter; // default createLineFormatter()
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

## WorkerIpcTransport

```ts
interface WorkerIpcTransportOptions {
  name?: string;
}
class WorkerIpcTransport implements Transport {
  readonly name: string;
  onError?: (err: unknown, entry: LogEntry) => void;
  write(entry: LogEntry, _formatted: string): void;
  /** Forward a cross-process level command to the main/parent thread. */
  sendLevelCommand(level: number): void;
  close(): void; // no-op; the Worker owns its lifecycle
}
function registerWorkerReceiver(
  ingest: (entry: LogEntry) => void,
  options?: WorkerReceiverOptions & { onLevelCommand?: (level: number) => void },
): () => void;
```

Worker-side transport that forwards each entry to the main / parent thread via
`self.postMessage()`. Safe to import in non-Worker environments — `write` is a
no-op when `self.postMessage` is unavailable. The main side decodes entries
with `registerWorkerReceiver`, which also forwards level commands to
`onLevelCommand`. When an explicit `worker` instance is passed and it exposes a
single-slot `onmessage` property, the pre-existing handler is saved and restored
by the returned unregister function. A circuit breaker (10 consecutive failures
→ 5 s window) suppresses per-entry noise if the main thread dies, while still
attempting delivery on every write so the channel recovers automatically.

## ClusterIpcTransport

```ts
interface ClusterIpcTransportOptions {
  channel?: string; // IPC channel name, default 'lograil:cluster:log'
  name?: string;
}
class ClusterIpcTransport implements Transport {
  readonly name: string;
  onError?: (err: unknown, entry: LogEntry) => void;
  write(entry: LogEntry, _formatted: string): void;
  /** Forward a cross-process level command to the primary process. */
  sendLevelCommand(level: number): void;
  close(): void; // no-op; the cluster module owns the worker lifecycle
}
function registerClusterReceiver(
  ingest: (entry: LogEntry) => void,
  options?: ClusterReceiverOptions & { onLevelCommand?: (level: number) => void },
): () => void;
```

Cluster-worker-side transport that forwards each entry to the primary process
via `process.send()`. Safe to import outside a cluster worker — `write` is a
no-op when `process.send` is unavailable. The primary side decodes entries with
`registerClusterReceiver`, which also forwards level commands to
`onLevelCommand`. A circuit breaker (5 consecutive failures → 5 s window)
suppresses per-entry noise if the primary dies.

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
   * Failed attempts are retried in place with exponential backoff. After the
   * final attempt a batch that still did not deliver (or was rejected with a
   * 4xx) increments {@link dropCount}; the record set is remembered for
   * exactly **one** more delivery attempt on the next `flush()` / `close()`
   * and then dropped permanently, so a permanently-failing endpoint costs at
   * most two flush cycles per batch. Default `3`. Set to `0` to disable
   * retries within a batch (fail fast per attempt).
   */
  maxRetries?: number;
  /**
   * Initial backoff delay in ms before the first retry. Doubles after each
   * retry, capped at {@link retryMaxDelayMs}. Default `250`.
   */
  retryInitialDelayMs?: number;
  /**
   * Maximum backoff delay in ms. Default `5000`.
   */
  retryMaxDelayMs?: number;  /**
   * Max entries the internal buffer can hold before the newest entry is dropped.
   * `0` means unlimited. Default `10_000`.
   */
  maxQueueSize?: number;
  /** Called when `maxQueueSize` is reached and an entry is dropped. */
  onQueueOverflow?: (entry: LogEntry, queueDepth: number) => void;
}

class OtlpTransport implements Transport {
  /** Total entries dropped due to queue overflow. */
  readonly overflowDropCount: number;
  /** Current number of entries waiting in the buffer. */
  readonly bufferLength: number;
  /** Records that failed delivery after their retry cycles. */
  readonly dropCount: number;
}
```

Forwards entries to an OpenTelemetry Collector over OTLP HTTP/JSON (`POST
/v1/logs`). Entries are buffered and sent in batches; call `logger.flush()` (or
enable `autoFlushOnExit`) to drain them. Requires a global `fetch` (Node >= 18,
modern browsers, Electron).

Because `write()` is synchronous, the generic logger-level `queueLimit` / `onOverflow`
does **not** apply. Use `maxQueueSize` / `onQueueOverflow` instead for OTLP
backpressure control.

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

## BroadcastChannelTransport

```ts
interface BroadcastChannelTransportOptions {
  name?: string;           // the BroadcastChannel name, default 'lograil'
  transportName?: string;  // Transport.name, default 'broadcast-channel'
  formatter?: Formatter;
}
class BroadcastChannelTransport implements Transport {
  readonly name: string;
  readonly formatter: Formatter;
  onError?: (err: unknown, entry: LogEntry) => void;
  /** Subscribe to entries this channel receives from other tabs. */
  subscribe(cb: (entry: LogEntry) => void): () => void;
  write(entry: LogEntry, formatted: string): void;
  close(): void;
}
function registerBroadcastChannelReceiver(
  ingest: (entry: LogEntry) => void,
  options?: { name?: string; transportName?: string },
): () => void;
```

Cross-tab / cross-window Web streaming transport. Each tab that `addTransport`
's it posts every entry to a shared `BroadcastChannel`; every other tab with
the same channel name and origin receives it via `subscribe` (or via
`registerBroadcastChannelReceiver`). Importable in every runtime — on platforms
without `BroadcastChannel` (Node, Electron main, older browsers) `write` is a
no-op and subscribers are never invoked.

## OS-native transports

Three transports forward a record to the operating system's own logging stack.
Each is importable in every runtime and never throws at module load; where the
underlying binary / facility is missing the transport degrades to the
`onError` path, circuit-broken so a broken sink cannot spam the console.

```ts
interface SyslogTransportOptions {
  name?: string;
  formatter?: Formatter;
  facility?: number;      // RFC 5424 facility, default 3 (LOG_DAEMON)
  protocol?: 'local' | 'udp';  // 'local' = logger binary, 'udp' = raw datagram
  host?: string;          // udp mode, default 'localhost'
  port?: number;          // udp mode, default 514
  tag?: string;           // logger -t tag, default the transport name
  loggerPath?: string;    // override the binary location
}
class SyslogTransport implements Transport { /* name, formatter, write, close, onError */ }

interface JournaldTransportOptions {
  name?: string;
  formatter?: Formatter;
  fields?: Record<string, string>;  // fixed KEY=VALUE journal fields (IDENTIFIER defaults to name)
  priority?: number;                // fixed PRIORITY journal field
}
class JournaldTransport implements Transport { /* name, formatter, write, close, onError */ }

interface WindowsEventLogTransportOptions {
  name?: string;
  formatter?: Formatter;
  log?: string;       // target event log, default the transport name
  source?: string;    // provider/source string, default the transport name
  eventId?: number;   // default record ID, default 1
}
class WindowsEventLogTransport implements Transport { /* name, formatter, write, close, onError */ }
```

- **`SyslogTransport`** — Unix via `logger` (`protocol: 'local'`) or a raw UDP
  datagram (`protocol: 'udp'`, via `nc`).
- **`JournaldTransport`** — Linux/systemd via one persistent `systemd-cat`
  process; `fields` become fixed journal fields.
- **`WindowsEventLogTransport`** — Windows via `eventcreate.exe`; per-entry
  event-ID override via `entry.metadata.wevtid`.

All three share the level → syslog-priority mapping (`trace`/`debug`→7,
`info`→6, `warn`→4, `error`→3, `fatal`→2). Platform gating: the Unix
transports require the respective binary; the Windows transport requires
`win32`. In a browser build every one degrades to the unavailable `onError`
path. See [Transports guide](/guide/transports#os-native-transports).
