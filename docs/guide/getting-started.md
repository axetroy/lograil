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

The package ships a ready-to-use logger whose runtime (Web / Node / Electron) is
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

## Browser builds & bundlers

`lograil` is **bundle-safe for the browser out of the box**. Importing it in a
Web page — via webpack, Vite, Rollup, esbuild, or any other bundler — works
without extra configuration:

- Node built-ins (`node:fs`, `node:path`, `node:os`, `node:async_hooks`) are
  never resolved directly. Instead they are routed through an internal
  `shims` layer, and the `browser` field in `package.json` swaps that layer for
  a browser stub at build time.
- The stubs make the **import** succeed everywhere. Runtime-only pieces still
  need a real host: `FileTransport` throws if you try to write a file in a
  browser (there is no filesystem), and the ambient async context is a no-op
  (see [Context](/api/context)).

If you only need console + remote transports, use `createWebRuntime()` — it
avoids file transports entirely:

```ts
import { createLogger, createWebRuntime } from 'lograil';

const log = createLogger({ runtime: createWebRuntime() });
```

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
