# API 参考

本包被组织为多个职责单一的模块，既可以从根入口导入，也可以通过 **子路径导出** 按需引入（有利于 tree-shaking——打包工具会自动移除未使用的代码）：

| 导入                          | 导出内容                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `lograil`            | 全部：logger、`createLogger`、类型、所有子模块                |
| `lograil/core`        | `Logger`、`Pipeline`、级别工具                                |
| `lograil/pipeline`    | `Filter`、`Processor`、`Formatter`、内置过滤器/处理器         |
| `lograil/transport`   | `Transport`、`ConsoleTransport`、`FileTransport`、`ElectronIpcTransport`、`OtlpTransport` |
| `lograil/runtime`     | 运行时适配器、`detectRuntime`、`registerIpcReceiver`          |
| `lograil/plugin`      | `Plugin`、`PluginManager`、`PluginContext`                    |
| `lograil/context`     | `ContextStore`、`createContextStore`、`runWithContext`、`asyncContext`、`isEmptyRecord` |

## 核心类型

```ts
type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
  level: number;
  levelName: LogLevelName;
  message: string;
  args: unknown[];
  timestamp: number; // 毫秒时间戳
  time: string; // ISO 时间戳
  scope?: string;
  pid?: number;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
  error?: Error;
}

type LogFn = (message: unknown, ...args: unknown[]) => void;
```

## 常量与工具函数

以下均从根导入 `lograil` 中再次导出。

```ts
const LOG_LEVELS: Record<LogLevelName, number>;   // { trace: 10, ..., fatal: 60 }
const LOG_LEVEL_NAMES: LogLevelName[];            // ['trace', 'debug', ..., 'fatal']

function normalizeLevel(input: LogLevelInput): number;
function isLogLevelName(value: unknown): value is LogLevelName;
function isLevelEnabled(configured: LogLevelInput, candidate: LogLevelInput): boolean;
function levelNameFromValue(value: number): LogLevelName;
function compareLevel(a: LogLevelInput, b: LogLevelInput): number; // <0 | 0 | >0

// 自定义级别——在内置级别之外注册一个命名级别（例如 `audit` 定为 45）。
// 注册后，该名称在 setLevel / getLevel / LOG_LEVEL 环境变量 / 各传输器的
// level / 级别命令中都成为一等公民。
function registerLevel(name: string, value: number): number;
function unregisterLevel(name: string): boolean;  // 内置级别返回 false
function listCustomLevels(): string[];

function freezeEntry<T extends LogEntry>(entry: T): T & FrozenLogEntry;
type FrozenLogEntry = Readonly<LogEntry> & {
  readonly context: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly args: readonly unknown[];
};
// 在条目抵达传输器边界时将其冻结（幂等）。条目会被自动冻结；
// 当你自行构建条目时使用此函数。参见[不可变性与零拷贝](../guide/immutability.md)。
```

相关类型：`LogLevelValue`（= `number`）、`LogLevelInput`（= 内置 `LogLevelName`、
任意已注册的自定义级别名（`string`）、或数值），
以及 `LoggerMethods`（即 `Logger` 实现的 `trace`…`fatal` 方法映射）。

- [Logger](/zh/api/logger)
- [传输器](/zh/api/transports)
- [管道](/zh/api/pipeline)
- [上下文](/zh/api/context)
- [插件](/zh/api/plugins)
- [运行时](/zh/api/runtime)
