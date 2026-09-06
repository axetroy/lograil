# Getting Started

## Installation

::: code-group

```bash [npm]
npm install lograil
```

```bash [yarn]
yarn add lograil
```

```bash [pnpm]
pnpm add lograil
```

```bash [bun]
bun add lograil
```

:::

## Quick start

The package ships a ready-to-use logger whose runtime (Web / Node / Electron, i.e. the different execution environments the library adapts to) is
auto-detected at import time. Log immediately — no setup required:

```ts
import { logger } from 'lograil';

logger.info('server started', { port: 3000 });
logger.warn('low disk space', { freeMb: 120 });
logger.error(new Error('boom'));
```

On **Node.js** and the **Electron main process** the default logger also writes
to a rotating file in addition to the console. On the **Web** and **Electron
renderer** it logs to the console (renderers forward to the main process over
IPC when running in Electron).

The default file transport is disk-safe out of the box: at most 10 MB per file,
about two weeks of daily files, and 200 MB total. Tune or lift these caps via
`fileTransportOptions` (see [Runtime](/api/runtime)).

::: warning Single process-wide instance

The exported `logger` is a **module-level singleton** created synchronously on
first import — it runs `detectRuntime()`, wires up the default transports
(including a `FileTransport` on Node / Electron main), and registers process
lifecycle hooks (`beforeExit`, `SIGINT`, `SIGTERM`).

- All code in the same process shares this one logger, the same ambient
  context (`AsyncLocalStorage` instance), and the same `process.*` listeners.
  The ambient context is **global** — a `runWithContext` call from any code
  affects every logger in the process, not just the one that called it. If you
  create multiple independent loggers and need isolated ambient contexts per
  logger, each logger needs its own `AsyncLocalStorage` store (currently there
  is no per-logger API for this — use a single logger with `scope` instead).
- If you need independent loggers (e.g. per-test harness, per-worker), use
  `createLogger(options)` instead.
- Lifecycle hooks are not detached automatically. Call
  `await logger.destroy()` in an `afterAll` hook if your test imports this
  module and you want a clean slate for sibling tests.
:::

See the runtime-specific guides for details:

- [Web Runtime](/guide/runtime-web) — browser bundle safety, `createWebRuntime()`
- [Node Runtime](/guide/runtime-node) — disk-safety defaults, `appName`, exit flushing
- [Electron](/guide/runtime-electron) — two-process model, preload bridge, IPC channel

## Context vs metadata

`LogEntry` carries two separate object fields — `context` and `metadata` — that serve different purposes. See [Context & Metadata](./context) for a full explanation with examples. The short version:

- **`context`** is persistent and inherited. Set it once with `log.setContext()` and every subsequent entry carries it. Child loggers get their own isolated copy seeded from the parent. Use it for request-scoped data like `userId`, `requestId`, `tenantId`.
- **`metadata`** is attached to a single entry only. It is usually injected by a processor or plugin (e.g. `durationMs`, `host`, `pid`). Use it for per-entry measurements or environment details that should not leak across requests.

## Structured logging

The first argument can be a string, an `Error`, or any value. Objects are kept
as structured data instead of being stringified to `[object Object]`:

```ts
// Error is extracted and rendered with its full cause chain
logger.error(new Error('db failed'), { query: 'select * from users' });

// A plain object is preserved as structured args
logger.info({ user: { id: 1 }, action: 'login' });
```

`Error` cause chains (including circular `cause`) are serialized safely in both
the human-readable line and JSON output.

## Scoped loggers

Derive a child logger that shares the same transports, pipeline and plugins, but
carries its own scope (joined with `:`) and an isolated context:

```ts
const http = logger.scope('http');

http.info('request received'); // scope: "http"
```

## Create your own instance

Use `createLogger` when you need a fully customized, separate instance:

```ts
import { createLogger } from 'lograil';

const log = createLogger({
  level: 'debug',
  transports: [/* ... */],
  context: /* ... */,
});
```

Continue to [Configuration](/guide/configuration) to learn about levels,
context, transports and the pipeline.
