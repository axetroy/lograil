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

## 消息格式化（`printf`）

当 `message` 是字符串且至少传入一个参数时，lograil 支持 Node `util.format` 的一个精简 `printf` 子集，因此你可以这样写：

```ts
logger.info('user %s logged in', name);
logger.info('cost %d', price);
logger.info('payload %j', { a: 1 }); // %j => JSON
logger.info('obj %o', { a: 1 });     // %o/%O => 对象预览
logger.info('done %s%%', '100');      // %% => 字面量 '%'
```

占位符（`%s %d %i %j %o %O %%`）会按顺序消费位置参数；**未被消费的**参数会像普通的 `logger.info('msg', obj)` 那样保留为结构化 `args`。如果消息里没有任何合法占位符（比如字面量 `50% off`），或者没有传入参数，消息会原样保留、`args` 也原样透传——也就是说，最常见的结构化日志调用仍走零格式化的快速路径。

这仅仅是对熟悉 Node `util.format` 的用户的便利写法。它**并不比模板字符串更快**：在 JavaScript 里，所有实参都会在调用前先求值，因此 `logger.info('user %s', name)` 与 `logger.info(\`user ${name}\`, …)` 是等价的——两者都会保留结构化 `args`，也都不会跳过实参求值。按你自己的喜好选择即可。

## 级别

```ts
logger.getLevel(): number;
logger.setLevel(level: LogLevelInput): void; // 名称或数值
```

### 跨进程级别同步

当 `Logger` 由支持 IPC 的运行时驱动时（Electron、Worker 线程、Cluster），在**任意进程**调用 `setLevel()` 都会自动将该级别广播给所有对等进程，无需手动接线。

```ts
import { logger } from 'lograil';

// 主进程 —— 所有渲染进程 / worker / cluster 对等方都会收到新级别
logger.setLevel('debug');

// 渲染进程 / worker / cluster —— 主进程也会收到
logger.setLevel('trace');
```

在需要拦截或检查来自对等方的级别命令的高级场景下，可使用 `setOnLevelCommand`：

```ts
logger.setOnLevelCommand((level: number) => {
  console.log('对等方请求的级别', level);
  logger.setLevel(level);
});
```

当收到对等方的级别命令时，`getLevel()` 会返回对等方的级别而非本地配置的级别——这样跨进程查询时行为一致：
```ts
import { logger } from 'lograil';
// 主进程设置为 debug；renderer.getLevel() 现在返回 20（debug）
logger.setLevel('debug');
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

子 logger 的创建是**轻量的**：它复用父 logger 的管道、插件、传输器与作用域过滤器，并且不会重新读取环境变量、编译正则或检测运行时。因此 `child()` 可以安全地按请求调用（例如 `logger.child({ requestId })`），不会有每次创建的额外分配开销。（只有根 logger 拥有共享资源——在子 logger 上调用 `destroy()` 不会销毁父 logger 的传输器与插件。）

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

## 错误处理

`log.*` 调用永远不会抛出。当 `Filter` / `Processor` / `plugin.onEntry` 抛错、
`Formatter` 抛错，或 `Transport.write` 抛错 / 卡住时，错误会通过 `onError`
选项（默认：原生 `console.error`）上报一次，并携带 `info.phase`
（`'filter' | 'process' | 'plugin' | 'formatter' | 'transport'`），且**绝不**
向上抛给调用方。异步 `Transport.write` 若在 `writeTimeoutMs`（默认 5000ms）内未
settle，会被作为超时错误上报，因此 `flush()` / `destroy()` 总会 resolve。详见
[配置](/zh/guide/configuration)。

当设置了 `maxQueueDepth`（或传输器自身的 `queueLimit`）且 pending 队列深度达到上限时，最新条目会**立即被丢弃**并通过 `onError` 上报（`phase: 'transport'`）。此举防止慢 sink 导致内存无限增长；只有被丢弃的条目丢失，已在队列中的早期条目仍按顺序正常写入。

## 安全说明

默认情况下 lograil **会**对常见敏感字段做脱敏处理。若你想关闭它，创建 logger 时传入 `secure: false`：

```ts
const logger = createLogger({ secure: false });
```

这会默认启用 `createRedactProcessor`（使用
`DEFAULT_SENSITIVE_KEYS` 内置密钥列表）。默认密钥列表涵盖
`password`、`token`、`apiKey`、`authorization`、`cookie`、`privateKey`、
`sessionId`、`csrf`、`otp`、`ssn`、`accessToken`、`bearer`、`appKey`、
`appSecret`、`clientKey`、`clientSecret`、`publishableKey`、`secretKey`、
`webhookSecret`、`cvv`、`pin` 等。已有的管线处理器不受影响，
脱敏会在这些现有处理器之后执行。

> **注意误脱敏：** 字段名如 `token`、`password` 若出现在非机密业务数据中
> （例如 `passwordResetCode`，或用户字段就叫 `token`）也会被替换为 `[REDACTED]`。
> 若默认列表过宽，可传入显式列表覆盖：
> `createLogger({ secure: true, pipeline: { processors: [createRedactProcessor(['secret', 'authorization'])] } })`。

## 进程集成

lograil 会挂载宿主的生命周期钩子，从而在退出时不丢失日志、并自动捕获崩溃。接线是**运行时无关**的：Logger 把 flush / 崩溃行为委托给当前 `RuntimeAdapter` 的 `lifecycle` 钩子，因此每个运行时监听自己原生的事件：

- **Node** — `beforeExit`、`SIGINT`（`130`）、`SIGTERM`（`143`）
- **Electron 主进程** — `app` 的 `before-quit` / `will-quit`（正常的窗口关闭路径），进程信号作为 CLI 启动时的回退
- **Web** — `pagehide` / `visibilitychange`（尽力而为；页面无论如何都会卸载）

```ts
// 在宿主退出时 flush 待写日志（默认关闭）。触发器由运行时拥有。
logger.attachExitHandlers(); // 或在创建时传入 new Logger({ autoFlushOnExit: true })

// 将未捕获异常 / 未处理的拒绝记录为 fatal 日志，然后 exit(1)。
logger.watchUncaughtErrors();

// 将 console.*（log/info/warn/error/debug/trace）桥接到 logger。
const restore = logger.redirectConsole(); // 返回一个用于还原 console 的函数
```

- `attachExitHandlers()` 在宿主退出前 flush。在 Node / Electron 上注册 `beforeExit`、`SIGINT`、`SIGTERM` 监听器（退出码 `130`/`143`）；在 Electron **主进程**上还会在 `app` 的 `before-quit` / `will-quit` 时 flush，使正常的窗口关闭不会丢弃缓冲中的日志。在浏览器中为空操作，且幂等。
- `watchUncaughtErrors()` 会将错误以 `fatal` 级别记录，随后以退出码 `1` 退出。
- `redirectConsole()` 把被捕获的 `console` 方法转交给 logger，并抑制原生输出。即使挂载了 `ConsoleTransport`，console 桥接也不会递归。**注意：** `console.*` 的参数会原样传给 logger，因此结构化对象（如 `console.log({ key })`）会变成日志消息字符串而非结构化数据——结构化日志请直接使用 logger API（`logger.info({ key })`）。
- 上述进程处理器同样会在 `destroy()` 时被移除。
