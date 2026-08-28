# Plugins

Plugins extend the logger through optional lifecycle hooks. Every hook is
optional; a plugin that wants to transform entries implements `onEntry`.

```ts
interface Plugin {
  /** Unique plugin name. */
  readonly name: string;
  onInit?(ctx: PluginContext): void | Promise<void>;
  onEntry?(entry: LogEntry): LogEntry | null | Promise<LogEntry | null>;
  onTransport?(transport: Transport): void;
  onDestroy?(): void | Promise<void>;
}
```

Return `null` from `onEntry` to **drop** an entry; return a (possibly new)
entry to pass it downstream.

## Registering a plugin

```ts
import { createLogger } from 'lograil';

const log = createLogger();

await log.use({
  name: 'add-host',
  onEntry(entry) {
    entry.metadata = { ...entry.metadata, host: os.hostname() };
    return entry;
  },
});
```

## PluginContext

`onInit` receives a `PluginContext` — the bridge that lets a plugin reconfigure
the logger at runtime:

```ts
interface PluginContext {
  addTransport(transport: Transport): void;
  removeTransport(name: string): void;
  pipeline: Pipeline; // add/remove filters & processors, change formatter
  use(plugin: Plugin): Promise<void>;
  unregisterPlugin(name: string): void;
  logger: Logger;
}
```

Example — a plugin that adds a redacting processor and a sampling filter:

```ts
import { createRedactProcessor, createLevelFilter, type Filter } from 'lograil';

// Keep roughly 10% of entries (random sampling).
const sampleFilter: Filter = () => Math.random() < 0.1;

log.use({
  name: 'secure',
  onInit(ctx) {
    ctx.pipeline.addProcessor(createRedactProcessor(['password', 'token']));
    ctx.pipeline.addFilter(sampleFilter);
    ctx.pipeline.addFilter(createLevelFilter(20)); // keep debug and above
  },
});
```

## Lifecycle

| Hook          | When                                                            |
| ------------- | --------------------------------------------------------------- |
| `onInit`      | When the plugin is registered (via `use`)                       |
| `onEntry`     | For every entry, before the formatter                           |
| `onTransport` | When a transport is added (including by other plugins)          |
| `onDestroy`   | On `unregisterPlugin` or `logger.destroy()`                     |

```ts
log.unregisterPlugin('secure'); // triggers onDestroy
log.hasPlugin('secure'); // false
```

Plugins are intercepted **asynchronously** in registration order, so `onEntry`
may be sync or async. Call `await log.flush()` / `await log.destroy()` to ensure
all plugin work completes before your process exits.

## Built-in plugin: OTel trace correlation

`createOtelTracePlugin()` automatically injects the active OpenTelemetry trace and
span identifiers into each entry's `metadata` (`traceId` / `spanId`), so an
`OtlpTransport` (or any backend that reads those fields) can correlate logs with
their span — without you threading the context manually.

`@opentelemetry/api` is an **optional** peer dependency. If it isn't installed, or
no span is active, the plugin is a no-op and entries are unaffected.

```ts
import { createOtelTracePlugin } from 'lograil';

await log.use(createOtelTracePlugin());

// inside a traced operation, the active span is picked up automatically:
logger.info('handling request'); // => metadata: { traceId, spanId }
```
