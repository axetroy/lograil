# 配置

`createLogger(options)` 接受一个 `LoggerOptions` 对象：

```ts
interface LoggerOptions {
  /** 输出的最低级别。默认 `info`。 */
  level?: LogLevelInput; // 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | number
  /** 该 logger 的可选作用域 / 命名空间。 */
  scope?: string;
  /** 运行时适配器。省略时自动探测。 */
  runtime?: RuntimeAdapter;
  /** 初始上下文存储。 */
  context?: ContextStore;
  /** 传输器。默认使用运行时提供的默认传输器。 */
  transports?: Transport[];
  /** 管道配置或实例。 */
  pipeline?: Pipeline | PipelineOptions;
  /** 共享的插件管理器（内部使用，由 scope() 使用）。 */
  plugins?: PluginManager;
  /**
   * 内部错误的全局处理器。当 `Filter`/`Processor`/`plugin.onEntry` 抛错、
   * `Formatter` 抛错，或 `Transport.write` 抛错 / 卡住时触发。未提供时，错误会被
   * 打印到原生的 `console.error`。logger 永远不会向上抛出这些错误。
   */
  onError?: (error: unknown, info: { phase: string; entry?: LogEntry; source?: string }) => void;
  /**
   * 等待异步 `Transport.write` 完成的最长时间（毫秒）。超时即视为失败并上报，
   * 从而避免某个卡住的传输器拖垮 `flush()`/`destroy()`。默认 5000。
   */
  writeTimeoutMs?: number;
}
```

## 内部错误处理

logger 的设计目标是 **`log.*` 调用永远不会抛出**。当某个内部环节出错——`Filter` /
`Processor` / `plugin.onEntry` 抛错、`Formatter` 抛错，或 `Transport.write` 抛错 /
卡住——错误会：

- 仅通过 `onError` 钩子（未设置时退回原生 `console.error`）上报一次，并携带 `info.phase`
  （`'filter' | 'process' | 'plugin' | 'formatter' | 'transport'`），以及在适用时携带出错的
  `source`（插件 / 传输器名称）与 `entry`；
- **绝不向上抛给调用方**，因此日志不可能拖垮你的应用。

出错的 `Processor` 或 `plugin.onEntry` 会保留上一条有效entry（不会被丢弃）；而出错的
`Filter` 会丢弃该条目（作为安全默认）。异步 `Transport.write` 若未在 `writeTimeoutMs`
内 settle，会被作为超时失败上报，队列继续前进，因此 `flush()` / `destroy()` 总会 resolve。

## 日志级别

级别按严重程度排序：

| 级别   | 数值 |
| ------ | ---- |
| trace  | 10   |
| debug  | 20   |
| info   | 30   |
| warn   | 40   |
| error  | 50   |
| fatal  | 60   |

`setLevel` 接受级别名或数值。低于该级别的条目会在进入管道前被丢弃：

```ts
log.setLevel('debug'); // 也可传入数值，例如 20
log.getLevel(); // 20
```

## 上下文

上下文用于保存会被附带到 **每一条** 日志中的结构化字段。只需设置一次，即可对后续所有日志生效：

```ts
log.setContext('requestId', 'abc-123');
log.mergeContext({ tenant: 'acme', env: 'prod' });
log.info('handling request'); // 包含 requestId/tenant/env
```

作用域 logger 会获得隔离的子上下文，因此在子 logger 上设置上下文不会泄漏到父 logger。

## 运行时选项

当运行时被自动探测时，你仍可通过 `detectRuntime` 或显式的工厂函数传入选项：

```ts
import { createNodeRuntime } from 'lograil/runtime';

const log = createLogger({
  runtime: createNodeRuntime({ appName: 'my-app', disableFile: false }),
});
```

| 运行时                  | 选项                    | 作用                                          |
| ----------------------- | ----------------------- | --------------------------------------------- |
| Node / Electron 主进程  | `logFile`               | 显式的滚动日志文件路径                         |
| Node                     | `appName`               | 用于推导默认日志路径（仅 Node）                |
| Node / Electron 主进程  | `fileTransportOptions`  | 透传给 `RotatingFileTransport`                |
| Node / Electron 主进程  | `disableFile`           | 仅控制台（不写文件）                          |
| Electron 主进程         | `receiveFromRenderer`   | 通过 IPC 接收渲染进程日志（默认 `true`）      |

完整的适配器契约见 [运行时](/zh/api/runtime)。
