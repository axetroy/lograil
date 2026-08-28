# 插件

插件通过可选的生命周期钩子来扩展 logger。所有钩子都是可选的；若插件需要转换条目，实现 `onEntry` 即可。

```ts
interface Plugin {
  /** 唯一插件名。 */
  readonly name: string;
  onInit?(ctx: PluginContext): void | Promise<void>;
  onEntry?(entry: LogEntry): LogEntry | null | Promise<LogEntry | null>;
  onTransport?(transport: Transport): void;
  onDestroy?(): void | Promise<void>;
}
```

在 `onEntry` 中返回 `null` 即可 **丢弃** 一条条目；返回（可能是新的）条目则继续往下传递。

## 注册插件

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

`onInit` 会收到一个 `PluginContext`——它是一座桥梁，让插件能够在运行时重新配置 logger：

```ts
interface PluginContext {
  addTransport(transport: Transport): void;
  removeTransport(name: string): void;
  pipeline: Pipeline; // 添加/移除过滤器与处理器，更换格式化器
  use(plugin: Plugin): Promise<void>;
  unregisterPlugin(name: string): void;
  logger: Logger;
}
```

示例——一个同时添加脱敏处理器与采样过滤器的插件：

```ts
import { createRedactProcessor, createLevelFilter, type Filter } from 'lograil';

// 仅保留约 10% 的条目（随机采样）。
const sampleFilter: Filter = () => Math.random() < 0.1;

log.use({
  name: 'secure',
  onInit(ctx) {
    ctx.pipeline.addProcessor(createRedactProcessor(['password', 'token']));
    ctx.pipeline.addFilter(sampleFilter);
    ctx.pipeline.addFilter(createLevelFilter(20)); // 保留 debug 及以上
  },
});
```

## 生命周期

| 钩子          | 触发时机                                              |
| ------------- | ----------------------------------------------------- |
| `onInit`      | 插件被注册时（通过 `use`）                             |
| `onEntry`     | 对每条条目，在格式化之前                               |
| `onTransport` | 有传输器被添加时（包括被其他插件添加）                |
| `onDestroy`   | 调用 `unregisterPlugin` 或 `logger.destroy()` 时      |

```ts
log.unregisterPlugin('secure'); // 触发 onDestroy
log.hasPlugin('secure'); // false
```

插件的拦截是 **异步** 的，且按注册顺序执行，因此 `onEntry` 既可以为同步也可以为异步。在进程退出前调用 `await log.flush()` / `await log.destroy()`，以确保所有插件工作都已完成。
