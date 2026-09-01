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

## Message formatting (`printf`)

When `message` is a `string` and at least one argument is passed, lograil
supports a tiny `printf`-style subset of Node's `util.format`, so you can write:

```ts
logger.info('user %s logged in', name);
logger.info('cost %d', price);
logger.info('payload %j', { a: 1 }); // %j => JSON
logger.info('obj %o', { a: 1 });     // %o/%O => object preview
logger.info('done %s%%', '100');      // %% => literal '%'
```

Specifiers (`%s %d %i %j %o %O %%`) consume positional arguments; any
**unconsumed** arguments are preserved as structured `args`, exactly like the
usual `logger.info('msg', obj)` form. If the message contains no legal
specifier (e.g. a literal `50% off`), or there are no arguments, the message is
kept verbatim and `args` are passed through unchanged — so the common
structured-logging call stays on the zero-format fast path.

This is purely a convenience for those used to Node's `util.format`. It is
**not** faster than a template literal: in JavaScript all arguments are
evaluated eagerly before the call, and `logger.info('user %s', name)` is
equivalent to `logger.info(\`user ${name}\`, …)` — both preserve structured
`args`, and neither avoids argument evaluation. Use whichever you prefer.

## Level

```ts
logger.getLevel(): number;
logger.setLevel(level: LogLevelInput): void; // name or number
```

### Cross-process level sync

When a `Logger` is backed by an IPC-capable runtime (Electron, Worker threads,
or Cluster), calling `setLevel()` on **any** process automatically broadcasts the
new level to every peer over the IPC channel. No manual wiring is needed.

```ts
import { logger } from 'lograil';

// Main process — all renderer / worker / cluster peers receive the new level
logger.setLevel('debug');

// Renderer / worker / cluster — main process also receives it
logger.setLevel('trace');
```

For advanced scenarios where you need to hook into level commands received from
a peer (e.g. to inspect or reject them), use `setOnLevelCommand`:

```ts
logger.setOnLevelCommand((level: number) => {
  console.log('peer requested level', level);
  logger.setLevel(level);
});
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

Child creation is **lightweight**: it reuses the parent's pipeline, plugins,
transports and namespace filter and performs no environment reads, regex
compilation or runtime detection. This makes `child()` safe to call per request
(e.g. `logger.child({ requestId })`) without per-call allocation overhead. (Only
the root logger owns shared resources — `destroy()` on a child does not tear
down the parent's transports or plugins.)

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

lograil hooks the host lifecycle so logs are never lost on shutdown and crashes
are captured automatically. The wiring is **runtime-agnostic**: the Logger
delegates flush / crash behaviour to the active `RuntimeAdapter`'s `lifecycle`
hooks, so each runtime listens on its own native events:

- **Node** — `beforeExit`, `SIGINT` (`130`) and `SIGTERM` (`143`)
- **Electron main** — `app` `before-quit` / `will-quit` (the normal window-close
  path), with the process signals as a fallback for CLI launches
- **Web** — `pagehide` / `visibilitychange` (best-effort; the page unloads anyway)

```ts
// Flush pending logs on host exit (default off). The runtime owns the trigger.
logger.attachExitHandlers(); // or new Logger({ autoFlushOnExit: true })

// Capture uncaught exceptions / unhandled rejections as fatal logs, then exit(1).
logger.watchUncaughtErrors();

// Bridge console.* (console.log/info/warn/error/debug/trace) into the logger.
const restore = logger.redirectConsole(); // returns a function that restores console
```

- `attachExitHandlers()` flushes before the host exits. On Node / Electron it
  registers `beforeExit`, `SIGINT` and `SIGTERM` (exit codes `130`/`143`); on an
  Electron **main** process it additionally flushes on `app` `before-quit` /
  `will-quit`, so a normal window close does not drop buffered logs. It is a
  no-op in the browser and is idempotent.
- `watchUncaughtErrors()` logs the error at `fatal` and then exits with code `1`.
- `redirectConsole()` routes the captured `console` methods through the logger
  and suppresses the native output. The console bridge is recursion-safe even
  when a `ConsoleTransport` is attached. Note: `console.*` arguments are
  passed as-is to the logger, so structured objects (e.g. `console.log({ key })`)
  become the log message string rather than structured data — use the logger
  API directly (`logger.info({ key })`) for structured logging.
- `destroy()` also removes any process handlers registered above.
