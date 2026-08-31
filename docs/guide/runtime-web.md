# Web Runtime

The Web runtime targets browsers. It has **no filesystem**, no process id, and
its default transport is `ConsoleTransport`.

> **Also see:** [Node Runtime](/guide/runtime-node) · [Electron](/guide/runtime-electron) —
> the three runtimes share the same API surface; this page covers browser-specific
> behavior.

## Default behavior

```ts
import { logger } from 'lograil';
```

In a browser, the default `logger` outputs to `console` only. There is no file
transport — no disk I/O, no rotation, no data leaves the browser.

## What works and what doesn't

| Feature | Web |
| --- | --- |
| `console` output | ✅ |
| Structured context / metadata | ✅ |
| Scopes, filters, processors, formatters | ✅ |
| Plugins | ✅ |
| `maxLevel` / level guards | ✅ |
| `FileTransport` | ❌ imports safely, but any `write()` call throws |
| `attachExitHandlers()` | no-op (nothing to hook) |
| Ambient async context | no-op (see [Context](/api/context)) |
| `OtlpTransport` | ✅ (requires `fetch` — all modern browsers) |

## `createWebRuntime()`

Use `createWebRuntime()` when you want to be explicit (e.g. when you know the
build targets the browser), or to skip the filesystem path entirely:

```ts
import { createLogger, createWebRuntime } from 'lograil';

const log = createLogger({ runtime: createWebRuntime() });
```

`createWebRuntime()` returns a `RuntimeAdapter` with:

- `hasFileSystem()` → `false`
- `pid()` → `0`
- `now()` → `Date.now()`
- `defaultTransports()` → `[new ConsoleTransport()]`
- Lifecycle hooks flush on `pagehide` / `visibilitychange` (not `process` events)

## Browser builds & bundlers

`lograil` is **bundle-safe for the browser out of the box**. Importing it in a
Web page — via webpack, Vite, Rollup, esbuild, or any other bundler — works
without extra configuration:

- Node built-ins (`node:fs`, `node:path`, `node:os`, `node:async_hooks`) are
  never resolved directly. They go through an internal `shims` layer, and the
  `browser` field in `package.json` swaps that layer for a browser stub at build
  time, so the import resolves cleanly.
- The stubs make the **import** succeed everywhere. Runtime-only pieces still
  need a real host: `FileTransport` throws in the browser (no filesystem), and
  ambient context is a no-op (see [Context](/api/context)).

If you only need console + remote transports, `createWebRuntime()` skips the
file transport path entirely:

```ts
import { createLogger, createWebRuntime } from 'lograil';

const log = createLogger({ runtime: createWebRuntime() });
log.info('sent to console and/or OTLP, never to disk');
```

## Worker support

When running inside a Web Worker or Node `worker_threads` worker, the runtime
automatically detects the Worker context and sends entries to the main/parent
thread via `postMessage()`. The main thread receives them via
`registerWorkerReceiver()` — attached automatically by `createWebRuntime()`.

| Role | Console | IPC transport |
| --- | --- | --- |
| **Worker** (Web Worker or `worker_threads`) | ✅ | ✅ `WorkerIpcTransport` (`self.postMessage`) |
| **Main/parent thread** | ✅ | ✅ `registerWorkerReceiver` auto-attached |

```ts
// worker.ts — zero-config, auto-detected
import { logger } from 'lograil';

logger.info('hello from worker'); // → console + forwarded to main thread
```

```ts
// main.ts — receives worker logs automatically
import { createLogger, createWebRuntime } from 'lograil';

const log = createLogger({ runtime: createWebRuntime() });
// Worker logs arrive and are fed into this logger automatically
```

No manual `registerWorkerReceiver` call is needed — `createWebRuntime()`
attaches it automatically on the main thread side.

## Overriding `now()`

The clock is injectable — useful for testing or monotonic timestamps:

```ts
createWebRuntime({ now: () => performance.timeOrigin + performance.now() });
```
