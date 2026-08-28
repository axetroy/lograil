# Logger

The `Logger` class is the unified facade. Use the default `logger` export or
`createLogger(options)`.

```ts
function createLogger(options?: LoggerOptions & { runtime?: RuntimeAdapter }): Logger;
const logger: Logger;
```

## Emitting

All methods share the `LogFn` signature `(message: unknown, ...args: unknown[]) => void`.

```ts
logger.trace(msg, ...args);
logger.debug(msg, ...args);
logger.info(msg, ...args);
logger.warn(msg, ...args);
logger.error(msg, ...args);
logger.fatal(msg, ...args);
```

- `message` may be a `string`, an `Error`, or any value. Objects are preserved as
  structured `args`; `Error`s are extracted and rendered with their cause chain.

## Level

```ts
logger.getLevel(): number;
logger.setLevel(level: LogLevelInput): void; // name or number
```

## Context

```ts
logger.setContext(key: string, value: unknown): void;
logger.mergeContext(values: Record<string, unknown>): void;
```

## Transports

```ts
logger.addTransport(transport: Transport): void;
logger.removeTransport(name: string): void;
logger.getTransports(): readonly Transport[];
```

## Pipeline & plugins

```ts
logger.getPipeline(): Pipeline;
logger.use(plugin: Plugin): Promise<void>;
logger.hasPlugin(name: string): boolean;
logger.unregisterPlugin(name: string): void;
```

## Scoped loggers

```ts
logger.scope(scope: string, context?: Record<string, unknown>): Logger;
```

Returns a child that shares the parent's transports, pipeline and plugins, with
its own `:`-joined scope and an isolated context store.

## Child loggers

```ts
logger.child(options?: { context?: Record<string, unknown>; level?: LogLevelInput }): Logger;
```

Derives a child logger that shares the parent's transports, pipeline, plugins and
runtime. The child:

- merges `options.context` on top of the parent's context (captured at creation),
- inherits the parent's scope,
- inherits the **parent's level live** unless `options.level` overrides it (the
  override also applies to any further descendants).

This is the canonical "child logger" (à la `pino.child`), ideal for per-request
context:

```ts
const reqLog = logger.child({ context: { requestId: req.id } });
reqLog.info('start'); // => context: { requestId: '...' }
```

## Ingesting external entries

```ts
logger.ingestEntry(entry: LogEntry): void;
```

Feed an externally produced entry (e.g. received from a renderer over IPC) into
the pipeline. Subject to the configured level and plugins.

## Error handling

A log call never throws. If a `Filter`/`Processor`/`plugin.onEntry` throws, a
`Formatter` throws, or a `Transport.write` throws or stalls, the error is reported
once via the `onError` option (default: native `console.error`) with
`info.phase` (`'filter' | 'process' | 'plugin' | 'formatter' | 'transport'`) and is
never propagated to the caller. An async `Transport.write` that does not settle
within `writeTimeoutMs` (default 5000ms) is reported as a timeout so `flush()` /
`destroy()` always resolve. See [Configuration](/guide/configuration) for details.

## Lifecycle

```ts
await logger.flush(): Promise<void>;
await logger.destroy(): Promise<void>;
```

`flush()` drains the async write queue (including async transports);
`destroy()` flushes, tears down plugins and closes transports. Call them before
your process exits to avoid losing buffered logs.

## Process integration

In a Node/Electron **main** process, lograil can hook the process lifecycle so
logs are never lost on shutdown and crashes are captured automatically.

```ts
// Flush pending logs on SIGINT/SIGTERM/beforeExit (default off).
logger.attachExitHandlers(); // or new Logger({ autoFlushOnExit: true })

// Capture uncaught exceptions / unhandled rejections as fatal logs, then exit(1).
logger.watchUncaughtErrors();

// Bridge console.* (console.log/info/warn/error/debug/trace) into the logger.
const restore = logger.redirectConsole(); // returns a function that restores console
```

- `attachExitHandlers()` registers `beforeExit`, `SIGINT` and `SIGTERM`
  listeners that flush before the event loop empties (exit codes `130`/`143`).
  It is a no-op in the browser and is idempotent.
- `watchUncaughtErrors()` logs the error at `fatal` and then exits with code `1`.
- `redirectConsole()` routes the captured `console` methods through the logger
  and suppresses the native output. The console bridge is recursion-safe even
  when a `ConsoleTransport` is attached.
- `destroy()` also removes any process handlers registered above.
