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
then exits (exit code 130 for `SIGINT`, 143 for `SIGTERM`). This is idempotent
and no-op outside Node.

```ts
const log = createLogger({ autoFlushOnExit: true }); // default
// or call explicitly:
log.attachExitHandlers();
```
