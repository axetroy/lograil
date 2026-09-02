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
  /**
   * Initial context store. When omitted the logger creates an empty one
   * automatically. See [Context & Metadata](./context) for when to use
   * `context` versus `metadata`.
   */
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
  /**
   * Environment variable (name) whose value — if set to a valid level name —
   * overrides `level`. Defaults to `"LOG_LEVEL"`. Set to `null` to disable.
   */
  levelEnvVar?: string | null;
  /**
   * Scope/namespace filter: a comma/space-separated list of glob patterns (with
   * `*` wildcards); a leading `-` excludes. Only entries whose `scope` matches are
   * emitted. Read automatically from `namespaceEnvVar` when omitted.
   */
  namespaceFilter?: string | string[];
  /**
   * Environment variable whose value supplies the namespace filter when
   * `namespaceFilter` is not set. Defaults to `"LOGRAIL_DEBUG"`. Set to `null`
   * to disable.
   */
  namespaceEnvVar?: string | null;
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

## Environment variables & namespace filtering

Two zero-config controls are available for operations without code changes.

### LOG_LEVEL

Set the `LOG_LEVEL` environment variable to a level name to override the configured
level at startup (useful for turning up verbosity in prod without a redeploy):

```bash
LOG_LEVEL=debug node server.js
```

Point it at a different variable with `levelEnvVar`, or disable with `levelEnvVar: null`.

### Namespace (scope) filtering

When you use scoped loggers (`logger.scope('http')`), you can restrict which scopes
actually emit via the `LOGRAIL_DEBUG` environment variable or the `namespaceFilter`
option. Syntax mirrors the popular `debug` package:

```bash
# enable http & db scopes (wildcards allowed), disable noisy http:noise
LOGRAIL_DEBUG='http*,db*,-http:noise' node server.js
```

```ts
const log = createLogger({ namespaceFilter: ['http*', 'db*', '-http:noise'] });
```

A leading `-` excludes a pattern; `*` matches any run of characters. `scope` is the
full dotted name (e.g. `http:server`), so `http*` matches it.

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
| Node / Electron main    | `appName`           | Required by `FileTransport`; always part of the log file name |
| Node / Electron main    | `fileTransportOptions` | Forwarded to `FileTransport` (mode `rotate-time`); overrides the disk-safety defaults (10 MB/file, 14 daily files, 200 MB total) |
| Node / Electron main    | `disableFile`       | Console-only (no file)                            |
| Electron main           | `receiveFromRenderer` | Receive renderer logs over IPC (default `true`) |

See [Runtime](/api/runtime) for the full adapter contract.
