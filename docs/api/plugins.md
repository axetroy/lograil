# Plugins

See the [Plugins guide](/guide/plugins) for usage. This page documents the
interface. A plugin may implement any subset of these hooks.

```ts
interface Plugin {
  readonly name: string;
  onInit?(ctx: PluginContext): void | Promise<void>;
  onEntry?(entry: LogEntry): LogEntry | null | Promise<LogEntry | null>;
  onTransport?(transport: Transport): void;
  onDestroy?(): void | Promise<void>;
}
```

Return `null` from `onEntry` to drop an entry.

## PluginContext

Passed to `onInit`, it is the bridge for runtime reconfiguration:

```ts
interface PluginContext {
  addTransport(transport: Transport): void;
  removeTransport(name: string): void;
  pipeline: Pipeline;
  use(plugin: Plugin): Promise<void>;
  unregisterPlugin(name: string): void;
  logger: Logger;
}
```

## PluginManager

The logger delegates registration and entry interception to a `PluginManager`:

```ts
class PluginManager {
  constructor(host: PluginContext);
  register(plugin: Plugin): Promise<void>;
  unregister(name: string): void; // calls onDestroy
  has(name: string): boolean;
  notifyTransport(transport: Transport): void;
  intercept(entry: LogEntry): Promise<LogEntry | null>;
  destroy(): Promise<void>;
}
```

Entries run through every plugin's `onEntry` hook in registration order; an
`async` hook is awaited. Plugin interception is chained into the logger's write
queue, so `logger.flush()` / `logger.destroy()` await it.
