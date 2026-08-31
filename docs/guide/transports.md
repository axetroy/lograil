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

// 2.1 — roll by size; fileName() shapes the archived names
new FileTransport({
  mode: 'rotate-size',
  appName: 'my-app',
  maxSize: 10 * 1024 * 1024,
  maxFiles: 5,
  fileName: (app, seq, ext) => `${app}.${seq}.${ext}`,
  formatter: createJsonFormatter(),
});

// 2.2 — roll by time; one dated file per day
new FileTransport({
  mode: 'rotate-time',
  appName: 'my-app',
  unit: 'day',
  fileName: (app, stamp, seq, ext) => `${app}.${stamp}.${seq}.${ext}`,
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

### OtlpTransport

Forwards entries to an OpenTelemetry Collector (or any OTLP HTTP/JSON receiver)
over `POST /v1/logs`. Entries are buffered and sent in batches; call
`flush()` (or enable `autoFlushOnExit` on the logger) to drain them before the
process exits. Requires a global `fetch` (Node >= 18, modern browsers, Electron).

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
