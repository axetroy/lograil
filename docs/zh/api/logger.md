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

## 子 Logger（child）

```ts
logger.child(options?: { context?: Record<string, unknown>; level?: LogLevelInput }): Logger;
```

派生出一个子 logger，与父 logger 共享传输器、管道、插件与运行时。子 logger：

- 把 `options.context` 合并到父 logger 上下文之上（在创建时捕获）；
- 继承父 logger 的作用域；
- **实时继承父 logger 的级别**，除非通过 `options.level` 覆盖（该覆盖同样对更深层子 logger 生效）。

这是成熟日志库标配的"子 logger"（类似 `pino.child`），非常适合用于请求级上下文：

```ts
const reqLog = logger.child({ context: { requestId: req.id } });
reqLog.info('start'); // => context: { requestId: '...' }
```

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

## 进程集成

在 Node / Electron **主进程**中，lograil 可以挂载进程生命周期钩子，从而避免在退出时丢失日志，并自动捕获崩溃。

```ts
// 在 SIGINT/SIGTERM/beforeExit 时 flush 待写日志（默认关闭）。
logger.attachExitHandlers(); // 或在创建时传入 new Logger({ autoFlushOnExit: true })

// 将未捕获异常 / 未处理的拒绝记录为 fatal 日志，然后 exit(1)。
logger.watchUncaughtErrors();

// 将 console.*（log/info/warn/error/debug/trace）桥接到 logger。
const restore = logger.redirectConsole(); // 返回一个用于还原 console 的函数
```

- `attachExitHandlers()` 注册 `beforeExit`、`SIGINT`、`SIGTERM` 监听器，在事件循环排空前 flush（退出码为 `130`/`143`）。在浏览器中为空操作，且幂等。
- `watchUncaughtErrors()` 会将错误以 `fatal` 级别记录，随后以退出码 `1` 退出。
- `redirectConsole()` 把被捕获的 `console` 方法转交给 logger，并抑制原生输出。即使挂载了 `ConsoleTransport`，console 桥接也不会递归。
- 上述进程处理器同样会在 `destroy()` 时被移除。
