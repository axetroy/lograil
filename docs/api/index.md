# API Reference

The package is organized into focused modules, each available from the root and
as a **subpath export** for tree-shaking:

| Import                          | Exports                                                           |
| ------------------------------- | ----------------------------------------------------------------- |
| `lograil`               | Everything: logger, `createLogger`, types, all submodules         |
| `lograil/core`          | `Logger`, `Pipeline`, level utilities                              |
| `lograil/pipeline`      | `Filter`, `Processor`, `Formatter`, built-in filters/processors   |
| `lograil/transport`     | `Transport`, `ConsoleTransport`, `RotatingFileTransport`, `ElectronIpcTransport`, `OtlpTransport` |
| `lograil/runtime`       | Runtime adapters, `detectRuntime`, `registerIpcReceiver`          |
| `lograil/plugin`        | `Plugin`, `PluginManager`, `PluginContext`                        |
| `lograil/context`       | `ContextStore`, `createContextStore`, `runWithContext`, `asyncContext`, `isEmptyRecord` |

## Core types

```ts
type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
  level: number;
  levelName: LogLevelName;
  message: string;
  args: unknown[];
  timestamp: number; // epoch ms
  time: string; // ISO timestamp
  scope?: string;
  pid?: number;
  context: Record<string, unknown>;
  metadata: Record<string, unknown>;
  error?: Error;
}

type LogFn = (message: unknown, ...args: unknown[]) => void;
```

## Constants & helpers

These are re-exported from the root `lograil` import.

```ts
const LOG_LEVELS: Record<LogLevelName, number>;   // { trace: 10, ..., fatal: 60 }
const LOG_LEVEL_NAMES: LogLevelName[];            // ['trace', 'debug', ..., 'fatal']

function normalizeLevel(input: LogLevelInput): number;
function isLogLevelName(value: unknown): value is LogLevelName;
function isLevelEnabled(configured: LogLevelInput, candidate: LogLevelInput): boolean;
function levelNameFromValue(value: number): LogLevelName;
function compareLevel(a: LogLevelInput, b: LogLevelInput): number; // <0 | 0 | >0
```

Related types: `LogLevelValue` (= `number`), `LogLevelInput` (= `LogLevelName | number`),
and `LoggerMethods` (the `trace`…`fatal` method map that `Logger` implements).

- [Logger](/api/logger)
- [Transports](/api/transports)
- [Pipeline](/api/pipeline)
- [Context](/api/context)
- [Plugins](/api/plugins)
- [Runtime](/api/runtime)
