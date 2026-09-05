# API Reference

The package is organized into focused modules, each available from the root and
as a **subpath export** for tree-shaking (build tools like Vite/Webpack will automatically remove unused code):

| Import                          | Exports                                                           |
| ------------------------------- | ----------------------------------------------------------------- |
| `lograil`               | Everything: logger, `createLogger`, types, all submodules         |
| `lograil/core`          | `Logger`, `Pipeline`, level utilities                              |
| `lograil/pipeline`      | `Filter`, `Processor`, `Formatter`, built-in filters/processors   |
| `lograil/transport`     | `Transport`, `ConsoleTransport`, `FileTransport`, `ElectronIpcTransport`, `OtlpTransport` |
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

function freezeEntry<T extends LogEntry>(entry: T): T & FrozenLogEntry;
type FrozenLogEntry = Readonly<LogEntry> & {
  readonly context: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly args: readonly unknown[];
};
// Freeze an entry at its transport boundary (idempotent). Entries are frozen for
// you automatically; use this when you build entries yourself. See
// [Immutability & zero-copy](../guide/immutability.md).
```

Related types: `LogLevelValue` (= `number`), `LogLevelInput` (= `LogLevelName | number`),
and `LoggerMethods` (the `trace`…`fatal` method map that `Logger` implements).

- [Logger](/api/logger)
- [Transports](/api/transports)
- [Pipeline](/api/pipeline)
- [Context](/api/context)
- [Plugins](/api/plugins)
- [Runtime](/api/runtime)
