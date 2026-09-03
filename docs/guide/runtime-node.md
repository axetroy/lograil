# Node Runtime

The Node runtime targets CLI tools, servers, workers, and any non-Electron
Node.js process. It is auto-detected and has both a process id and filesystem
access.

> **Also see:** [Web Runtime](/guide/runtime-web) · [Electron](/guide/runtime-electron) —
> the three runtimes share the same API surface; this page covers Node-specific
> behavior.

## Default behavior

```ts
import { logger } from 'lograil';

logger.info('server started', { port: 3000 });
```

When the runtime resolves to Node, the default `logger` logs to:

1. **Console** (`ConsoleTransport`)
2. **Rotating file** (`FileTransport`, mode `rotate-time`, unit `day`)

Daily files are written under `os.tmpdir()` by default (override via
`fileTransportOptions: { dir }`). The `appName` is embedded in every file name
and determines the set of files the transport owns.

### Disk-safety defaults

The built-in `FileTransport` is bounded out of the box — a zero-config logger
will never eat the disk:

| Cap | Default | What it limits |
| --- | --- | --- |
| `maxSize` | 10 MB | per-file size (active file) |
| `maxFiles` | 14 | daily buckets kept (~2 weeks) |
| `maxTotalSize` | 200 MB | absolute disk ceiling for all owned files |

All caps can be lifted or tuned via `fileTransportOptions`:

```ts
import { createLogger, createNodeRuntime } from 'lograil';

const log = createLogger({
  runtime: createNodeRuntime({
    appName: 'my-server',
    fileTransportOptions: {
      dir: '/var/log/my-server', // override default tmpdir
      maxFiles: 30,              // keep a month of daily files
      maxTotalSize: 500 * 1024 * 1024, // 500 MB ceiling
    },
  }),
});
```

## `appName`

Every `FileTransport` requires an `appName` — it is embedded in the log file
name (e.g. `my-server.2026-08-31.log`) so the file is identifiable by its
owning application.

- **Explicit:** pass `appName` in the runtime options or `fileTransportOptions`.
- **Inferred:** when `appName` is omitted, `createNodeRuntime()` derives it from
  the invoked script (`process.argv[1]`) — for example `node server.js` yields
  `appName: 'server'`. If inference fails (e.g. in a REPL), the runtime throws.

```ts
// Explicit — always recommended for libraries / workers
createNodeRuntime({ appName: 'my-lib' });

// Inferred — works for CLI entry points
createNodeRuntime(); // appName derived from process.argv[1]
```

## `createNodeRuntime()`

Use `createNodeRuntime()` when you need to customize behavior — disable the file
transport, change the directory, or set a known app name:

```ts
import { createLogger, createNodeRuntime } from 'lograil';

// Console only — no file
const log = createLogger({
  runtime: createNodeRuntime({ disableFile: true }),
});
```

### Options

| Option | Type | Effect |
| --- | --- | --- |
| `appName` | `string` | Application name for file names; inferred if omitted |
| `disableFile` | `boolean` | Console only (default `false`) |
| `fileTransportOptions` | `Partial<RotateTimeOptions>` | Forwarded to the `FileTransport` (mode `rotate-time`) |

`fileTransportOptions` accepts all `RotateTimeOptions` fields except `mode` (which
is always `rotate-time`) and `appName` (taken from the top-level option):

```ts
createNodeRuntime({
  appName: 'worker',
  fileTransportOptions: {
    unit: 'hour',        // rotate every hour instead of daily
    maxFiles: 48,        // keep 48 hourly files
    fileName: (app, stamp, ext) => `${app}-${stamp}.${ext}`,
  },
});
```

## Exit flushing

When `autoFlushOnExit` is enabled (the default), the logger automatically
registers `beforeExit`, `SIGINT`, and `SIGTERM` handlers. On a normal exit the
event loop drains pending writes; on a signal, the logger flushes what it can and
then exits (exit code 130 for `SIGINT`, 143 for `SIGTERM`). On Windows,
`SIGBREAK` (Ctrl+Break) is also registered as a best-effort signal hook — note
that `taskkill` and OS shutdown terminate without emitting any signal, so the
`beforeExit` handler remains the only portable shutdown flush path. This is
idempotent and no-op outside Node.

```ts
const log = createLogger({ autoFlushOnExit: true }); // default
// or call explicitly:
log.attachExitHandlers();
```

## Cluster support

When running inside `node:cluster`, the runtime automatically detects whether
the current process is a worker or the primary and adjusts behavior:

| Role | File transport | IPC transport |
| --- | --- | --- |
| **Primary** (`cluster.isPrimary`) | ✅ `FileTransport` (rotate-time, daily) | ✅ `registerClusterReceiver` auto-attached |
| **Worker** (`cluster.isWorker`) | ❌ disabled | ✅ `ClusterIpcTransport` (via `process.send`) |

Workers do not write files — they send every entry to the primary process over
the cluster IPC channel, where entries are fed into the primary's logger. This
avoids file corruption from concurrent writes and keeps the log files unified
under one `appName`.

```ts
// cluster.ts — zero-config, auto-detected
import cluster from 'node:cluster';
import { logger } from 'lograil';

if (cluster.isPrimary) {
  // primary: console + file + receives worker logs
  for (let i = 0; i < 4; i++) cluster.fork();
} else {
  // worker: console + sends to primary via process.send()
  logger.info('worker started');
}
```

No manual `registerClusterReceiver` call is needed — `createNodeRuntime()`
attaches it automatically on the primary side.

### Cross-process level sync

Calling `setLevel()` on the primary process automatically broadcasts the new
level to all cluster workers via the same IPC channel. Workers that call
`setLevel()` also send the command back to the primary. No manual wiring is
required.

## Worker threads support

When running inside a `worker_threads` worker, the runtime automatically
detects the worker context and sends entries to the parent thread via
`postMessage()`. The parent thread receives them via `registerWorkerReceiver()`
(attached automatically by `createNodeRuntime()`).

| Role | File transport | IPC transport |
| --- | --- | --- |
| **Parent** (main thread) | ✅ `FileTransport` | ✅ `registerWorkerReceiver` auto-attached |
| **Worker** (`worker_threads`) | ❌ disabled | ✅ `WorkerIpcTransport` (`self.postMessage`) |

This uses the same `WorkerIpcTransport` as Web Workers — both Web and Node
workers share the same `postMessage` protocol.

```ts
// parent.ts
import { createLogger, createNodeRuntime } from 'lograil';

const log = createLogger({ runtime: createNodeRuntime() });

// Worker thread logs arrive automatically
```

```ts
// worker.ts — zero-config, auto-detected
import { createLogger, createWebRuntime } from 'lograil';

// In a worker_threads worker, createWebRuntime() detects the context
const log = createLogger({ runtime: createWebRuntime() });
logger.info('hello from worker_threads'); // → console + forwarded to parent
```

### Cross-process level sync

Like the Cluster mode, Worker threads also receive automatic level broadcasts.
Calling `setLevel()` on the parent thread propagates to every worker, and vice
versa — the level command travels over the same `postMessage` channel used for
log entries.
