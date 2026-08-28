# Configuration

`createLogger(options)` accepts a `LoggerOptions` object:

```ts
interface LoggerOptions {
  /** Minimum level to emit. Default `info`. */
  level?: LogLevelInput; // 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | number
  /** Optional scope / namespace for this logger. */
  scope?: string;
  /** Runtime adapter. Auto-detected when omitted. */
  runtime?: RuntimeAdapter;
  /** Initial context store. */
  context?: ContextStore;
  /** Transports. Defaults to the runtime's default transports. */
  transports?: Transport[];
  /** Pipeline configuration or instance. */
  pipeline?: Pipeline | PipelineOptions;
  /** Shared plugin manager (internal, used by scope()). */
  plugins?: PluginManager;
  /**
   * Global handler for internal errors (a throwing filter/processor/plugin, a
   * failing formatter, or a broken transport). When omitted, errors are printed
   * to the native `console.error`. The logger never rethrows them.
   */
  onError?: (error: unknown, info: { phase: string; entry?: LogEntry; source?: string }) => void;
  /**
   * Max time (ms) to wait for an async `Transport.write` before treating it as
   * failed, so a stalled sink can never hang `flush()`/`destroy()`. Default 5000.
   */
  writeTimeoutMs?: number;
}
```

## Internal error handling

The logger is designed to **never throw from a `log.*` call**. If an internal
step fails — a `Filter`/`Processor`/`plugin.onEntry` throws, a `Formatter`
throws, or a `Transport.write` throws or stalls — the error is:

- reported exactly once via the `onError` hook (or the native `console.error`
  when no hook is set), passing `info.phase` (`'filter' | 'process' | 'plugin' |
  'formatter' | 'transport'`) and, where applicable, the offending `source`
  (plugin/transport name) and the `entry`;
- **never propagated to the caller**, so logging can never crash your app.

A broken `Processor` or `plugin.onEntry` keeps the last good entry (it is not
dropped); a throwing `Filter` drops the entry (as a safe default). An async
`Transport.write` that does not settle within `writeTimeoutMs` is reported as a
timeout failure and the queue moves on, so `flush()`/`destroy()` always resolve.

## Log levels

Levels are ordered by severity:

| Level   | Value |
| ------- | ----- |
| trace   | 10    |
| debug   | 20    |
| info    | 30    |
| warn    | 40    |
| error   | 50    |
| fatal   | 60    |

`setLevel` accepts either a level name or a numeric value. Entries below the
configured level are dropped before reaching the pipeline:

```ts
log.setLevel('debug'); // also accepts a number, e.g. 20
log.getLevel(); // 20
```

## Context

Context holds structured fields attached to **every** entry. Set it once and it
travels with all subsequent logs:

```ts
log.setContext('requestId', 'abc-123');
log.mergeContext({ tenant: 'acme', env: 'prod' });
log.info('handling request'); // includes requestId/tenant/env
```

Scoped loggers get an isolated child context, so setting context on a child
never leaks to the parent.

## Runtime options

When the runtime is auto-detected you can still pass options via `detectRuntime`
or the explicit factory functions:

```ts
import { createNodeRuntime } from 'lograil/runtime';

const log = createLogger({
  runtime: createNodeRuntime({ appName: 'my-app', disableFile: false }),
});
```

| Runtime                 | Option              | Effect                                            |
| ----------------------- | ------------------- | ------------------------------------------------- |
| Node / Electron main    | `logFile`           | Explicit rotating log file path                   |
| Node                     | `appName`           | Derives the default log path (Node only)          |
| Node / Electron main    | `fileTransportOptions` | Forwarded to `RotatingFileTransport`           |
| Node / Electron main    | `disableFile`       | Console-only (no file)                            |
| Electron main           | `receiveFromRenderer` | Receive renderer logs over IPC (default `true`) |

See [Runtime](/api/runtime) for the full adapter contract.
