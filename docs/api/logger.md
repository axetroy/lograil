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

## Ingesting external entries

```ts
logger.ingestEntry(entry: LogEntry): void;
```

Feed an externally produced entry (e.g. received from a renderer over IPC) into
the pipeline. Subject to the configured level and plugins.

## Lifecycle

```ts
await logger.flush(): Promise<void>;
await logger.destroy(): Promise<void>;
```

`flush()` drains the async write queue (including async transports);
`destroy()` flushes, tears down plugins and closes transports. Call them before
your process exits to avoid losing buffered logs.
