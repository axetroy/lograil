# Runtime

The runtime adapter isolates environment differences (clock, process id,
filesystem, default transports) behind a single interface.

```ts
type RuntimeName = 'web' | 'node' | 'electron';
type ElectronProcessType = 'main' | 'renderer';

interface RuntimeAdapter {
  readonly name: RuntimeName;
  readonly processType?: ElectronProcessType;
  now(): number;
  pid(): number | undefined;
  hasFileSystem(): boolean;
  defaultTransports(): Transport[];
  attachReceiver?: (ingest: IngestFn) => () => void;
  /**
   * Host lifecycle hooks. When present, the Logger wires its flush-on-exit and
   * crash-logging through these instead of touching `process` / `window`
   * directly, so each runtime controls *when* it exits and owns any
   * `process.exit()`. Omit (or leave `undefined`) on runtimes where the logger
   * should not react to host lifecycle. The built-in adapters already provide
   * this: Node → process events, Electron main → `app` `before-quit` /
   * `will-quit`, Web → `pagehide` / `visibilitychange`.
   */
  lifecycle?: LifecycleHooks;
}
```

## Lifecycle hooks

`LifecycleHooks` decouples the logger from the host. The logger supplies the
behaviour (flush with a timeout, log the crash at `fatal`); the runtime owns the
trigger:

```ts
interface LifecycleHooks {
  // Flush pending entries before the host closes. Returns an unregister fn.
  onFlushBeforeExit(cb: () => void | Promise<void>): () => void;
  // Optional: log fatal, uncaught host errors (Node/Electron only).
  onUncaughtError?(cb: (err: unknown) => void | Promise<void>): () => void;
}
```

You only implement this when writing a **custom** runtime adapter; the built-in
`createNodeRuntime` / `createWebRuntime` / `createElectronMainRuntime` /
`createElectronRendererRuntime` already attach the right hooks, so
`autoFlushOnExit` / `watchUncaughtErrors` work out of the box per platform.

## Detection

```ts
import { detectRuntime, createWebRuntime, createNodeRuntime, createElectronRuntime } from 'lograil/runtime';

detectRuntime(options?); // auto-detects Electron → Node → Web
```

`detectRuntime` picks:

1. **Electron** when `process.versions.electron` exists,
2. **Node.js** when a Node process is present,
3. **Web** otherwise.

For Electron you can be explicit:

```ts
import { createElectronMainRuntime, createElectronRendererRuntime } from 'lograil/runtime';

createElectronMainRuntime(options?);
createElectronRendererRuntime(options?);
```

## Default transports

| Runtime            | Default transports                                  |
| ------------------ | --------------------------------------------------- |
| Web                | `ConsoleTransport`                                  |
| Node.js            | `ConsoleTransport` + `FileTransport` (`rotate-time`, daily, with disk-safety defaults) |
| Electron main      | `ConsoleTransport` + `FileTransport` (`rotate-time`, daily, with disk-safety defaults), receives renderer IPC |
| Electron renderer  | `ConsoleTransport` (forward to main via IPC)         |

**Disk-safety defaults**: the default file transport on Node and Electron main
ships with capacity caps so a zero-config logger never eats the disk — at most
10 MB per file (`maxSize`), about two weeks of daily files (`maxFiles: 14`),
and 200 MB total across all log files (`maxTotalSize`). Override any of them
via `fileTransportOptions`.

## Web runtime

```ts
createWebRuntime();
```

The Web runtime targets browsers. It has **no filesystem** (`hasFileSystem()`
returns `false`), no process id, and its default transport is `ConsoleTransport`
only. Its lifecycle hooks flush on `pagehide` / `visibilitychange` instead of
`process` events. Because Node built-ins are stubbed via the `browser` field,
importing it in a browser bundle is always safe.

```ts
createLogger({ runtime: createWebRuntime() });
```

## Options

```ts
interface NodeRuntimeOptions {
  appName?: string; // required by FileTransport; inferred from the entry script if omitted
  fileTransportOptions?: Partial<Omit<RotateTimeOptions, 'mode'>>; // forwarded to the default `FileTransport` (overrides the disk-safety defaults)
  disableFile?: boolean;
}

interface ElectronMainRuntimeOptions {
  // log files use appName main/renderer; default dir: app.getPath('logs')
  // (override via fileTransportOptions: { dir })
  fileTransportOptions?: Partial<Omit<RotateTimeOptions, 'mode'>>;
  disableFile?: boolean;
  receiveFromRenderer?: boolean; // default true
}
```

Pass options through `detectRuntime` or the explicit factory:

```ts
createLogger({ runtime: createNodeRuntime({ appName: 'my-app', disableFile: false }) });
```

## Constants & types

```ts
// The IPC channel renderer → main logs travel on.
const LOGRAIL_CHANNEL: string; // 'lograil:log'

type RuntimeName = 'web' | 'node' | 'electron';
type ElectronProcessType = 'main' | 'renderer';
// Callback that feeds a received entry back into a logger.
type IngestFn = (entry: LogEntry) => void;
```

`forwardToMain`, `channel` and `ipcRenderer` are specific to
`createElectronRendererRuntime`:

```ts
interface ElectronRendererRuntimeOptions {
  forwardToMain?: boolean; // default true — forward to main over IPC
  channel?: string;        // override the IPC channel
  // Injected IPC sender. Required when the renderer cannot reach
  // require('electron') (e.g. nodeIntegration:false + contextIsolation:true):
  // pass the ipcRenderer exposed by a preload bridge instead of letting the
  // transport call require('electron') itself.
  ipcRenderer?: { send(channel: string, ...args: unknown[]): void };
}
```

When `ipcRenderer` is provided it is used directly; otherwise the transport falls
back to `require('electron').ipcRenderer`, which is unavailable in a locked-down
renderer. See the [Electron guide](/guide/runtime-electron#secure-setup-preload-contextisolation)
for the preload pattern.

`RuntimeName` / `ElectronProcessType` / `IngestFn` are part of the `RuntimeAdapter`
contract (see the [Runtime adapter interface](/api/runtime)) and are useful when
writing a custom adapter or a custom IPC bridge.
