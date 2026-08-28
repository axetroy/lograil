# Logger

`Logger` 类是对外的统一门面。可以使用默认的 `logger` 导出，也可以通过 `createLogger(options)` 创建。

```ts
function createLogger(options?: LoggerOptions & { runtime?: RuntimeAdapter }): Logger;
const logger: Logger;
```

## 输出日志

所有方法共享 `LogFn` 签名 `(message: unknown, ...args: unknown[]) => void`。

```ts
logger.trace(msg, ...args);
logger.debug(msg, ...args);
logger.info(msg, ...args);
logger.warn(msg, ...args);
logger.error(msg, ...args);
logger.fatal(msg, ...args);
```

- `message` 可以是 `string`、`Error` 或任意值。对象会被保留为结构化 `args`；`Error` 会被提取并连同其 `cause` 因果链一起渲染。

## 级别

```ts
logger.getLevel(): number;
logger.setLevel(level: LogLevelInput): void; // 名称或数值
```

## 上下文

```ts
logger.setContext(key: string, value: unknown): void;
logger.mergeContext(values: Record<string, unknown>): void;
```

## 传输器

```ts
logger.addTransport(transport: Transport): void;
logger.removeTransport(name: string): void;
logger.getTransports(): readonly Transport[];
```

## 管道与插件

```ts
logger.getPipeline(): Pipeline;
logger.use(plugin: Plugin): Promise<void>;
logger.hasPlugin(name: string): boolean;
logger.unregisterPlugin(name: string): void;
```

## 作用域 Logger

```ts
logger.scope(scope: string, context?: Record<string, unknown>): Logger;
```

返回一个子 logger，它与父 logger 共享传输器、管道与插件，但拥有自己的（以 `:` 拼接的）作用域与隔离的上下文存储。

## 接收外部条目

```ts
logger.ingestEntry(entry: LogEntry): void;
```

将与外部产生的条目（例如通过 IPC 从渲染进程收到的）注入管道。会经过已配置的级别与插件过滤。

## 生命周期

```ts
await logger.flush(): Promise<void>;
await logger.destroy(): Promise<void>;
```

`flush()` 会排空异步写入队列（包含异步传输器）；`destroy()` 会先 flush，再释放插件并关闭传输器。在进程退出前调用它们，可以避免丢失缓冲中的日志。
