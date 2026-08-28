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
}
```

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
