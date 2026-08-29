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

### RotatingFileTransport

File transport with rotation, for Node.js and the Electron main process.

```ts
import { RotatingFileTransport, createJsonFormatter } from 'lograil';

new RotatingFileTransport({
  path: '/var/log/app.log',
  daily: true, // default: one dated file per day
  maxFiles: 99, // daily ring buffer size (default 99 / size 5)
  maxSize: 10 * 1024 * 1024, // size-mode threshold (size mode only)
  formatter: createJsonFormatter(),
});
```

- **Daily mode** (default): active file is `app.{YYYY-MM-DD}.{01..maxFiles}.log`.
  When the index would exceed `maxFiles` it wraps back to `01` and clears it — a
  per-day ring buffer.
- **Size mode** (`daily: false`): classic generation rotation
  `app.log` → `app.1.log` → `app.2.log` … when the active file exceeds
  `maxSize`.

Use the `filter` option to split one logger's output across multiple files. The
built-in Electron main runtime already uses it to separate main-process logs
(`main.{date}.{idx}.log`) from renderer logs (`renderer.{date}.{idx}.log`):

```ts
import { RotatingFileTransport, createJsonFormatter } from 'lograil';

// Only renderer entries (tagged via metadata by the IPC bridge).
new RotatingFileTransport({
  path: '/var/log/renderer.log',
  daily: true,
  filter: (e) => e.metadata?.renderer === 'renderer',
  formatter: createJsonFormatter(),
});
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
