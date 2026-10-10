# Transports

A **transport** is the final sink of a log entry — console, file, IPC, or your
own destination. The `Transport` interface is intentionally tiny:

```ts
interface Transport {
  /** Unique name, used for diagnostics and removal. */
  readonly name: string;
  /** Optional per-transport formatter that overrides the pipeline default. */
  readonly formatter?: Formatter;
  /** Optional minimum level; entries below it are skipped by this sink only. */
  readonly level?: LogLevelInput;
  /** Emit a processed entry (sync or async). */
  write(entry: LogEntry, formatted: string): void | Promise<void>;
  /** Optional flush; awaited by `logger.flush()`. */
  flush?(): void | Promise<void>;
  /** Optional teardown. */
  close?(): void | Promise<void>;
}
```

## Built-in transports

### ConsoleTransport

Writes to the global `console`, mapping each level to the matching method
(`warn` → `console.warn`, `error`/`fatal` → `console.error`, …).

```ts
import { ConsoleTransport, createLineFormatter } from 'lograil';

new ConsoleTransport({
  name: 'console',
  formatter: createLineFormatter(),
  methodMap: { fatal: (...a) => console.error('FATAL', ...a) },
});

Override `methodMap` to route a level to a different `console` method, or to
prefix its output. By default each level maps to the like-named `console` method,
and `fatal` maps to `console.error` (so it appears on `stderr` in most terminals).

### FileTransport

File transport with several modes, for Node.js and the Electron main process.
`appName` is required and is always part of the file name. The mode is a
discriminated union, so each mode exposes only its own fields:

```ts
import { FileTransport, createJsonFormatter } from 'lograil';

// 1.1 / 1.2 — single file (append forever, or truncate when maxSize is hit)
new FileTransport({
  mode: 'single', // or 'single-truncate'
  appName: 'my-app',
  maxSize: 10 * 1024 * 1024, // required for 'single-truncate'
  formatter: createJsonFormatter(),
});

// 2.1 — roll by size; archives are named `${app}.${seq}.${ext}`
new FileTransport({
  mode: 'rotate-size',
  appName: 'my-app',
  maxSize: 10 * 1024 * 1024,
  maxFiles: 5,
  formatter: createJsonFormatter(),
});

// 2.2 — roll by time; one dated file per day, named `${app}.${stamp}.${seq}.${ext}`
new FileTransport({
  mode: 'rotate-time',
  appName: 'my-app',
  unit: 'day',
  formatter: createJsonFormatter(),
});

// 2.3 — roll on your own predicate
new FileTransport({
  mode: 'rotate-custom',
  appName: 'my-app',
  shouldRotate: (entry) => entry.levelName === 'error',
  fileName: (app, seq, ext) => `${app}.${seq}.${ext}`,
  formatter: createJsonFormatter(),
});
```

### Global capacity caps (optional)

Both `maxTotalSize` and `maxAge` can be added to **any** file mode. They are
evaluated independently of the per-mode `maxFiles` limit and work across all
modes, but only have practical effect when the mode actually produces multiple
files (i.e. any of the `rotate-*` modes). The active file is never deleted.

- `maxTotalSize: number` — delete the oldest history files until the combined
  size of the active file + history falls under this byte limit. Default:
  `Infinity` (no limit).
- `maxAge: number` — delete history files whose modification time is older than
  this many milliseconds.
  - `undefined` or `-1` (default): no limit.
  - `0`: delete all history files immediately.
  - `>0`: threshold in milliseconds.

Example with `rotate-size`:
```ts
new FileTransport({
  mode: 'rotate-size',
  appName: 'my-app',
  maxSize: 10 * 1024 * 1024,
  maxFiles: 100,
  maxTotalSize: 100 * 1024 * 1024, // keep at most 100 MB of logs total
  maxAge: 30 * 24 * 60 * 60 * 1000, // and drop anything older than 30 days
});
```

- **`single`** — one `<appName>.log` file, appended forever (until the disk fills).
- **`single-truncate`** — same single file, but once `maxSize` would be exceeded the
  current content is renamed to `<appName>.bak` and the original is truncated.
- **`rotate-size`** — when `size + bytes > maxSize`, shift generations
  (`app.log` → `app.1.log` → …) bounded by `maxFiles`.
- **`rotate-time`** — at each `hour`/`day` boundary open a new file named with a
  timestamp. Set `maxSize` to also split within the same time bucket when a
  single file grows too large (e.g. `app.2026-08-31.0.log`, `app.2026-08-31.1.log`).
- **`rotate-custom`** — `shouldRotate(entry, ctx)` decides when to cut; `fileName`
  names every file. Total control over rotation.

Use the `filter` option to split one logger's output across multiple files — e.g.
the built-in Electron main runtime separates main-process logs from renderer logs
by giving each its own `FileTransport` with `appName: 'main'` / `'renderer'`.

### Exporting log files

`FileTransport` provides methods to list and inspect log files on disk, so you
can build an "export logs" feature in your application:

```ts
import { logger, FileTransport } from 'lograil';

// Find the FileTransport from the default singleton
const fileTransport = logger.getTransports()
  .find((t): t is FileTransport => t instanceof FileTransport);

if (fileTransport) {
  // The directory where log files are stored
  console.log(fileTransport.getDir()); // /var/log/myapp

  // The file currently being written to
  console.log(fileTransport.getActiveFile()); // /var/log/myapp/myapp.log

  // List all log files (including old ones from previous runs)
  const files = await fileTransport.getFiles();
  // [
  //   { name: 'myapp.log', path: '/var/log/myapp/myapp.log', size: 4096, mtime: 1725168000000, active: true },
  //   { name: 'myapp.2026-08-31.0.log', path: '...', size: 8192, mtime: 1725081600000, active: false },
  // ]

  // Only files created during this session (excludes old files)
  const sessionFiles = await fileTransport.getFiles({ currentSessionOnly: true });
}
```

Then read, package, and download the files however you need:

```ts
import { readFile } from 'node:fs/promises';
import { ZipFile } from 'yazl'; // or any archiving library

async function exportLogs() {
  const files = await fileTransport.getFiles();
  const zip = new ZipFile();
  for (const f of files) {
    const content = await readFile(f.path, 'utf-8');
    zip.addBuffer(Buffer.from(content), f.name);
  }
  zip.end();
  // ... output the zip file
}
```

### ElectronIpcTransport

Renderer-side transport that forwards each entry to the main process over IPC.
The `electron` module is required lazily, so this is safe to import outside
Electron.

```ts
import { ElectronIpcTransport } from 'lograil';

const log = createLogger({
  runtime: createWebRuntime(), // renderers have no filesystem
  transports: [new ElectronIpcTransport()],
});
```

On the main process, enable IPC ingestion so renderer entries are persisted:

```ts
import { createElectronMainRuntime, registerIpcReceiver } from 'lograil';

const log = createLogger({ runtime: createElectronMainRuntime() });
// or simply: logger (default main runtime already attaches the receiver)
```

### WorkerIpcTransport

Worker-side transport that forwards each entry to the main / parent thread via
`self.postMessage()`. Safe to import in non-Worker environments — `write` is a
no-op when `self.postMessage` is unavailable. On the main / parent side, decode
entries with `registerWorkerReceiver`, which also forwards level commands to
`onLevelCommand`.

```ts
import { WorkerIpcTransport, registerWorkerReceiver } from 'lograil';

// worker.ts — auto-attached by createWebRuntime() when in a Worker
logger.info('hello from worker'); // → console + forwarded to main thread

// main.ts — receives worker logs automatically
const off = registerWorkerReceiver((entry) => logger.ingestEntry(entry));
```

### ClusterIpcTransport

Cluster-worker-side transport that forwards each entry to the primary process
via `process.send()`. Safe to import outside a cluster worker — `write` is a
no-op when `process.send` is unavailable. On the primary side, decode entries
with `registerClusterReceiver`, which also forwards level commands to
`onLevelCommand`.

```ts
import { ClusterIpcTransport, registerClusterReceiver } from 'lograil';

// worker.ts — auto-attached by createNodeRuntime() in cluster workers
logger.info('hello from worker'); // → console + forwarded to primary

// primary.ts — receives worker logs
const off = registerClusterReceiver((entry) => logger.ingestEntry(entry));
```

### OtlpTransport

Forwards entries to an OpenTelemetry Collector (or any OTLP HTTP/JSON receiver)
over `POST /v1/logs`. Entries are buffered and sent in batches; call
`flush()` (or enable `autoFlushOnExit` on the logger) to drain them before the
process exits. Requires a global `fetch` (Node >= 18, modern browsers, Electron).

Transient failures (network error or 5xx) are retried in place with exponential
backoff (`maxRetries`, `retryInitialDelayMs`, `retryMaxDelayMs`). A batch that
still does not deliver after its retries — or is rejected with a 4xx — counts
its records into `dropCount`; the records get exactly **one more** delivery
attempt on the next `flush()` / `close()` and are then dropped permanently.
This bounds the re-send cost against a permanently-failing collector to two
flush cycles per batch instead of re-sending on every shutdown.

```ts
import { OtlpTransport } from 'lograil';

new OtlpTransport({
  endpoint: 'http://localhost:4318/v1/logs', // OTLP HTTP receiver
  serviceName: 'my-service',
  resource: { 'deployment.environment': 'prod' },
});
```

Context fields `traceId` / `spanId` (or `trace_id` / `span_id`) are mapped
automatically to OTLP's dedicated trace-correlation fields, so logs join the same
distributed trace in your backend.

Per-transport `level` lets one logger fan out — combine an `OtlpTransport` at
`error` with a file transport at `info`, for example.

### LiveTransport

An in-memory, subscribable transport for **live log streaming** — instead of
writing to a sink, it forwards every entry to in-process subscribers. It is the
building block for a debug panel, a webview log viewer, or a React/Vue hook that
renders the stream. Zero-dependency and runtime-agnostic (Web, Node, Electron).

There are two ways to consume the stream, depending on how you want to render it:

#### Render by entity (`subscribe`)

You receive the **raw, frozen `LogEntry`** and render it however you like — a
level badge, an expandable `context`/`metadata` tree, click-to-copy, filtering by
field, etc. This is the right choice when your UI is structured (React/Vue
components keyed by entry) rather than a plain text log.

```ts
import { LiveTransport } from 'lograil';

const live = new LiveTransport({ bufferSize: 100 });
logger.addTransport(live);

// entry is frozen & zero-copy — never mutate it.
const unsubscribe = live.subscribe((entry) => {
  // e.g. <LogRow level={entry.levelName} msg={entry.message} ctx={entry.context} />
  renderRow(entry);
});
```

#### Render by formatted string (`onFormatted`)

You receive a **pre-formatted text line** (produced by the transport's formatter,
or the entry's `message` when none is set) and append it to a text view. This is
the right choice for a simple console-like pane where you just want lines of text.

```ts
import { LiveTransport, createLineFormatter } from 'lograil';

const live = new LiveTransport({ formatter: createLineFormatter() });
logger.addTransport(live);

// line is already formatted; entry is also passed if you need it.
const unsubscribe = live.onFormatted((line, entry) => {
  appendLine(line); // e.g. textarea / <pre> / terminal component
});
```

> The two modes are independent subscriptions — you can use either, or both at
> once. `subscribe` always delivers the raw entry; `onFormatted` only computes the
> string lazily when a formatted subscriber is actually attached.

#### Replay, buffer & teardown

```ts
// Late subscribers can replay the buffer (most-recent-first when true).
live.replay((entry) => backfill(entry), true);

console.log(live.subscriberCount); // active subscribers
live.clearBuffer(); // drop buffered entries
unsubscribe(); // stop receiving
```

Key behaviors:

- **Hot-path safe.** A subscriber that throws is caught and logged; it never
  breaks the logger's `write()` or other subscribers.
- **Zero-copy.** Subscribers receive the same frozen `LogEntry` reference the
  pipeline produced — do not mutate it.
- **Buffering.** Set `bufferSize > 0` to keep a ring buffer for late subscribers
  (via `replay`). `0` (default) disables buffering entirely.
- **Teardown.** `close()` clears all subscribers and the buffer.

For cross-process streaming (Electron main → renderer/webview) pair it with the
existing IPC channel, or use `BroadcastChannelTransport` for cross-tab Web
streaming.

### BroadcastChannelTransport

Cross-tab / cross-window Web streaming. Each tab that adds the transport
posts every entry to a shared `BroadcastChannel`; every other tab with the
same channel name and origin receives it. Safe to import in every runtime —
on platforms without `BroadcastChannel` (Node, Electron main, older
browsers) `write` is a no-op and subscribers are never invoked.

```ts
import {
  ConsoleTransport,
  BroadcastChannelTransport,
  registerBroadcastChannelReceiver,
} from 'lograil';

// Every tab in the same origin, logging to this channel:
const log = createLogger({
  transports: [new ConsoleTransport(), new BroadcastChannelTransport({ name: 'my-app' })],
});
log.info('from tab A'); // also visible in tab B

// In tab B (the receiving side) — feed foreign entries back into the local
// logger so they get the same file/console treatment:
const off = registerBroadcastChannelReceiver(
  (entry) => log.ingestEntry(entry),
  { name: 'my-app' },
);
```

- The channel name (`name`) is the coordination key: all participants must
  use the same name and same origin. The transport name
  (`transportName`) is just the `Transport.name` used for diagnostics /
  removal.
- `write()` posts the **frozen entry** (zero-copy within a tab). The other
  tabs deserialise a fresh entry via the channel's structured clone.
- Subscribe inline instead of going through the logger with
  `transport.subscribe((entry) => render(entry))` — returns an unsubscribe
  function.
- **Per-tab loop protection.** An entry posted by tab A is delivered to tab
  B, but not echoed back into tab A (the stub and the real `BroadcastChannel`
  both only deliver to *other* instances of the channel).

## OS-native transports

lograil ships three transports that hand a record off to the operating
system's own logging infrastructure. Each is **importable everywhere** (Web,
Node, Electron) and never throws at module load; on platforms where the
underlying binary or facility is missing, the transport degrades gracefully and
reports failures through `onError`, bounded by a circuit breaker so a broken
sink cannot spam the console.

- **`SyslogTransport`** — Unix (BSD / Linux) via the `logger` utility.
- **`JournaldTransport`** — Linux / systemd via a persistent `systemd-cat`.
- **`WindowsEventLogTransport`** — Windows via `eventcreate.exe`.

All three use a level → priority mapping shared from `os-native.ts`
(`trace`/`debug`→7, `info`→6, `warn`→4, `error`→3, `fatal`→2).

### SyslogTransport

```ts
import { SyslogTransport, createJsonFormatter } from 'lograil';

const syslog = new SyslogTransport({
  name: 'syslog',
  tag: 'myapp',                 // logger -t tag
  facility: 3,                  // LOG_DAEMON (default)
  protocol: 'local',            // 'local' (logger binary) | 'udp' (raw datagram)
  host: 'localhost',           // udp mode
  port: 514,                   // udp mode
  formatter: createJsonFormatter(),
});
log.addTransport(syslog);
```

- `protocol: 'local'` (default) spawns `logger -t <tag> -p <facility>.<pri> <msg>`
  per record. `logger` ships with every BSD and most Linux distributions.
- `protocol: 'udp'` sends a raw `<pri>timestamp host tag: msg` datagram over
  UDP using `nc` (netcat) — useful when the target is a network syslog server
  and no `logger` binary is available.
- Override the binary location with `loggerPath` for non-standard installs.

### JournaldTransport

```ts
import { JournaldTransport } from 'lograil';

const journal = new JournaldTransport({
  name: 'journald',
  fields: { UNIT: 'myapp.service', APP: 'myapp' },
  priority: 4,                  // fixed PRIORITY journal field (optional)
});
log.addTransport(journal);
```

- Spawns **one persistent** `systemd-cat` process and pipes newline-delimited
  records to its stdin for the lifetime of the transport (no per-record spawn).
- `fields` become fixed journal `KEY=VALUE` fields; `IDENTIFIER` defaults to
  the transport name.
- If `priority` is omitted, a default `PRIORITY=6` field is applied.
- On hosts without `systemd-cat` the spawn fails and each write is reported via
  `onError` (circuit-broken after 10 consecutive failures / 5 s window).

### WindowsEventLogTransport

```ts
import { WindowsEventLogTransport } from 'lograil';

const wlog = new WindowsEventLogTransport({
  name: 'winlog',
  log: 'Application',          // target event log
  source: 'MyApp',            // provider/source string
  eventId: 1,                 // default record ID
});
log.addTransport(wlog);
```

- Uses `eventcreate.exe /t <type> /l <log> /s <source> /d <data> /id <id>`,
  built into Windows Vista and later. `type` is derived from the entry level
  (`error`/`fatal` → `error`, otherwise `information`).
- Per-entry override: set `entry.metadata.wevtid` to a number to use a custom
  event ID for that record.
- Custom `source` values must be pre-registered in the Windows event system;
  writing to `Application` / `System` logs needs admin rights. Both surface as
  `onError` until resolved.
- On non-Windows platforms the transport is importable but every write reports
  `not available on this platform` via `onError` (circuit-broken).

> **Platform gating.** Each transport checks `os.platform()` at write time:
> `SyslogTransport` and `JournaldTransport` require a Unix / Linux host with
> the respective binary; `WindowsEventLogTransport` requires `win32`. In a
> browser build the shims report `platform === 'browser'` and the transport
> degrades to the unavailable path.

## Custom transports

Implement the `Transport` interface — that's all:

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

Add or remove transports at runtime:

```ts
log.addTransport(httpTransport);
log.removeTransport('http');
```

## Error handling

`Transport.onError` is called when `write()` fails — the logger catches the error
and forwards it instead of throwing. `FileTransport` additionally reports
non-fatal internal errors through the same hook: failed file deletions during
rotation, unreadable log directories, or backup rename failures.

These internal errors are classified by severity:

- `'warn'` — an unexpected best-effort operation failed (e.g. `readdir` or
  `rm` during a capacity check). The transport keeps running, but the problem
  should be investigated.
- `'debug'` — a routine cleanup step failed (e.g. deleting a backup file).
  Normally harmless; useful only for deep debugging.

To observe these errors, set `onError` on the transport instance:

```ts
import { FileTransport } from 'lograil';

const ft = new FileTransport({
  mode: 'rotate-size',
  appName: 'my-app',
  maxSize: 10 * 1024 * 1024,
  maxFiles: 5,
});

ft.onError = (err, entry) => {
  console.error('[file-transport]', err.message, entry.levelName);
};
```

In Electron apps, avoid routing `onError` through `console.*` if you have called
`redirectConsole()` — use `process.stderr` or a dedicated sink instead to prevent
infinite recursion. See [Troubleshooting](/guide/troubleshooting#1-console-output-causes-infinite-recursion-stack-overflow).

Most transport errors are transient and self-healing (e.g. a temporarily locked
file). If `onError` fires repeatedly for the same root cause, check disk space,
permissions, or antivirus interference.

## Error handling

`Transport.onError` is called when `write()` fails — the logger catches the error
and forwards it instead of throwing. `FileTransport` additionally reports
non-fatal internal errors through the same hook: failed file deletions during
rotation, unreadable log directories, or backup rename failures.

These internal errors are classified by severity:

- `'warn'` — an unexpected best-effort operation failed (e.g. `readdir` or
  `rm` during a capacity check). The transport keeps running, but the problem
  should be investigated.
- `'debug'` — a routine cleanup step failed (e.g. deleting a backup file).
  Normally harmless; useful only for deep debugging.

To observe these errors, set `onError` on the transport instance:

```ts
import { FileTransport } from 'lograil';

const ft = new FileTransport({
  mode: 'rotate-size',
  appName: 'my-app',
  maxSize: 10 * 1024 * 1024,
  maxFiles: 5,
});

ft.onError = (err, entry) => {
  console.error('[file-transport]', err.message, entry.levelName);
};
```

In Electron apps, avoid routing `onError` through `console.*` if you have called
`redirectConsole()` — use `process.stderr` or a dedicated sink instead to prevent
infinite recursion. See [Troubleshooting](/guide/troubleshooting#1-console-output-causes-infinite-recursion-stack-overflow).

Most transport errors are transient and self-healing (e.g. a temporarily locked
file). If `onError` fires repeatedly for the same root cause, check disk space,
permissions, or antivirus interference.
