# 插件

用法请参阅 [插件指南](/zh/guide/plugins)。本页说明其接口。插件可以实现以下钩子的任意子集。

```ts
interface Plugin {
  readonly name: string;
  onInit?(ctx: PluginContext): void | Promise<void>;
  onEntry?(entry: LogEntry): LogEntry | null | Promise<LogEntry | null>;
  onTransport?(transport: Transport): void;
  onDestroy?(): void | Promise<void>;
}
```

在 `onEntry` 中返回 `null` 即可丢弃该条目。

## PluginContext

在 `onInit` 中传入，是运行时重新配置的桥梁：

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

logger 将注册与条目拦截委托给 `PluginManager`：

```ts
class PluginManager {
  constructor(host: PluginContext);
  register(plugin: Plugin): Promise<void>;
  unregister(name: string): void; // 调用 onDestroy
  has(name: string): boolean;
  notifyTransport(transport: Transport): void;
  intercept(entry: LogEntry): Promise<LogEntry | null>;
  destroy(): Promise<void>;
}
```

条目会按注册顺序经过每个插件的 `onEntry` 钩子；异步钩子会被 `await`。插件拦截会被链式接入 logger 的写入队列，因此 `logger.flush()` / `logger.destroy()` 会等待其完成。
