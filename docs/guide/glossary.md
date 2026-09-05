# Glossary

This page explains the main terms used in lograil.

## Core concepts

### LogEntry

A single immutable log record with level, message, timestamp, scope, context, metadata, and more.

```ts
interface LogEntry {
  level: number; // numeric level (trace=10, debug=20, ...)
  levelName: string; // level name ('info', 'error', ...)
  message: string; // log message
  args: unknown[]; // structured arguments
  timestamp: number; // epoch milliseconds
  scope?: string; // namespace (e.g. 'api')
  context: Record<string, unknown>; // request-scoped context (userId, requestId, ...)
  metadata: Record<string, unknown>; // per-entry metadata (durationMs, host, ...)
  error?: unknown; // error object
}
```

### Pipeline

The processing chain for each log entry: **Filter → Processor → Formatter**.

```text
Your code → Logger → [Filter → Processor → Formatter] → Transport → Output
                                   ↓
                                Pipeline
```

### Filter

Decides whether an entry is kept. Return `true` to keep, `false` to drop.

```ts
type Filter = (entry: LogEntry) => boolean;
```

### Processor

Transforms or enriches an entry. Returns a `LogEntry`.

```ts
type Processor = (entry: LogEntry) => LogEntry;
```

### Formatter

Converts a `LogEntry` into output text.

Built-in formatters:
- `createLineFormatter()` — human-readable line output
- `createJsonFormatter()` — structured JSON output

```ts
type Formatter = (entry: LogEntry, config: FormatterConfig) => string;
```

### Transport

The destination for logs. Each transport can have its own level threshold and formatter.

Built-in transports:
- `ConsoleTransport` — writes to `console.*`
- `FileTransport` — writes to files (with rotation)
- `ElectronIpcTransport` — forwards logs to Electron main process through IPC
- `OtlpTransport` — sends logs to OpenTelemetry Collector

```ts
interface Transport {
  name: string;
  formatter?: Formatter;
  level?: LogLevelInput;
  write(entry: LogEntry, formatted: string): void | Promise<void>;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

## Runtime concepts

### Runtime Adapter

Bridges lograil with a runtime (Web / Node.js / Electron). It provides runtime-specific capabilities such as:
- filesystem access (Node/Electron)
- process ID (`pid()`)
- shutdown hooks (`beforeExit` / `SIGINT` / `SIGTERM`)
- IPC support (Electron)

### IPC

Inter-Process Communication. In Electron, renderer logs are forwarded to the main process, which can persist them to files.

### OTLP

OpenTelemetry Protocol. lograil uses `OtlpTransport` to send logs to an OpenTelemetry Collector and correlate with tracing.

### ESM / CJS

- **ESM** (ECMAScript Modules) — uses `import` / `export`
- **CJS** (CommonJS) — uses `require()` / `module.exports`

lograil ships both formats.

### Tree-shaking

Build tools (such as Vite and Webpack) remove unused code. lograil supports this with subpath exports like `lograil/core`.

## Log levels

From low to high:

| Level | Value | Typical usage |
|------|------|------|
| trace | 10 | most detailed debugging |
| debug | 20 | development diagnostics |
| info | 30 | general information |
| warn | 40 | warnings |
| error | 50 | errors |
| fatal | 60 | unrecoverable failures |

## Scope

A `:`-joined namespace, such as `app:http` or `app:db`, used to separate logs by module and for filtering.

```ts
const http = logger.scope('http'); // scope: 'app:http'
http.info('request received'); // entry includes scope 'app:http'
```

## Context

Key/value pairs set via `setContext()` and attached to every log entry automatically. Useful for request-scoped data like `userId` and `requestId`.

This is logger-owned context (stored on the logger itself), not ambient async context propagation.

Children inherit context from the parent, but with isolated copies.

```ts
logger.setContext('userId', 'u-123');
logger.info('hello'); // -> { context: { userId: 'u-123' }, ... }
```

## Metadata

Per-entry extra fields, usually injected by a processor or plugin. Metadata is not persistent across calls.

```ts
const metadataProcessor: Processor = (entry) => ({
  ...entry,
  metadata: { ...entry.metadata, source: 'api' },
});
```

## Ambient async context

Request-scoped context propagation built on Node.js `AsyncLocalStorage`. Context flows across async boundaries without manual parameter plumbing.
See [Context](/api/context) for the exact API signature and usage.

## Plugin

A component that extends logging behavior. Plugins can:
- add/remove transports
- modify pipeline stages
- intercept and transform/drop entries

```ts
interface Plugin {
  name: string;
  onInit?(ctx: PluginContext): void;
  onEntry?(entry: LogEntry): LogEntry | null;
  onTransport?(transport: Transport): void;
  onDestroy?(): void;
}
```
