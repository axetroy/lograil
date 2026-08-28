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
}
```

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
