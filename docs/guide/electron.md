# Electron

`lograil` is built for Electron's two-process model and works **out of the
box**: just import the default `logger` and it behaves correctly in both the main
and renderer processes. You usually don't need `createLogger` or any runtime
configuration.

## Zero-config (recommended)

### Main process

```ts
// main.ts
import { app, BrowserWindow } from 'electron';
import { logger } from 'lograil';

app.whenReady().then(() => {
  const win = new BrowserWindow({ /* ... */ });
  win.loadFile('index.html');

  logger.info('app ready'); // → console + daily rotating file
});
```

That's all. The main process logs to the console **and** a daily rotating file
under `<appData>/Lograil/`, and automatically receives logs sent by
renderer processes over IPC.

### Renderer process

```ts
// renderer.ts
import { logger } from 'lograil';

logger.warn('something happened in the UI');
// → local console, AND forwarded to the main process over IPC
```

The default renderer logger writes to the local console (visible in DevTools) and
forwards entries to the main process, where they land in the **same** rotating
file as the main process's own logs.

No setup, no `createLogger`, no wiring required.

## ⚠️ Requirement: the renderer must be able to reach Electron

For renderer → main forwarding to work, the **renderer process must be able to
access the `electron` module** (`require('electron')`).

Modern Electron ships with `nodeIntegration` disabled and `contextIsolation`
enabled by default, so the renderer's main world has **no `require` and no Node
globals** (including `process`). In that case `lograil` can't detect
Electron in the renderer and silently falls back to the **Web runtime** — logs
print to the console only and never reach the main process.

Enable Node in the renderer (simplest):

```ts
new BrowserWindow({
  webPreferences: {
    nodeIntegration: true,
    // contextIsolation: false, // required alongside nodeIntegration in some setups
  },
});
```

> Security note: `nodeIntegration: true` reduces isolation. For production, prefer
> a `preload` script that exposes only `ipcRenderer` and a custom bridge, or enable
> Node integration only for trusted content. The library degrades gracefully —
> without access to `electron` it just logs locally and drops the IPC send.

## Secure setup (preload + contextIsolation)

With the recommended Electron defaults (`nodeIntegration: false`,
`contextIsolation: true`), the renderer's main world has **no `require` and no
`process`**, so the built-in `ElectronIpcTransport` (which calls
`require('electron')`) cannot reach `ipcRenderer`. The fix is a **preload** that
exposes a thin `send` function through `contextBridge`, then a small custom
transport that uses it. No library changes are needed — only the public API
(`addTransport` + `LOGRAIL_CHANNEL`).

**preload.ts** (runs in the privileged context, has `require`):

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronLogger', {
  send: (channel: string, data: unknown) => ipcRenderer.send(channel, data),
});
```

Point the window at the preload:

```ts
import { app, BrowserWindow, path } from 'electron';

app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
});
```

**main.ts** — the default `logger` already listens for renderer entries; be
explicit if you prefer:

```ts
import { logger, registerIpcReceiver } from 'lograil';

registerIpcReceiver((entry) => logger.ingestEntry(entry));
```

**renderer.ts** — build the renderer logger with the preload bridge injected
as the `ipcRenderer`. This is the first-class way; no manual transport needed:

```ts
import { createLogger, createElectronRendererRuntime } from 'lograil';

declare global {
  interface Window {
    electronLogger?: { send: (channel: string, data: unknown) => void };
  }
}

// The bridge only exists if the preload ran; fall back to a plain (console-only)
// logger when it is absent.
const log = window.electronLogger
  ? createLogger({
      runtime: createElectronRendererRuntime({ ipcRenderer: window.electronLogger }),
    })
  : createLogger();

log.warn('UI event'); // → console + forwarded to main over the preload bridge
```

If you would rather keep the default `logger` singleton, you can instead register
the bridge as a transport:

```ts
import { logger, LOGRAIL_CHANNEL, type Transport } from 'lograil';

const bridge = window.electronLogger;
if (bridge) {
  const ipcTransport: Transport = {
    name: 'ipc-preload',
    write(entry) {
      bridge.send(LOGRAIL_CHANNEL, entry);
    },
  };
  logger.addTransport(ipcTransport);
}
```

Both approaches preserve a console log in the renderer (visible in DevTools) while
satisfying Electron's secure defaults.

## Customizing (advanced)

Only reach for `createLogger` + an explicit runtime when you want to change the
log path, disable the file, or stop receiving renderer logs.

```ts
// main.ts — custom log path / disable file
import { createLogger, createElectronMainRuntime } from 'lograil';

const log = createLogger({
  runtime: createElectronMainRuntime({
    appName: 'my-app', // derives the default log path
    // logFile: '/custom/path/app.log',
    // disableFile: false,
    receiveFromRenderer: true, // default — receive renderer logs over IPC
  }),
});
```

```ts
// renderer.ts — keep logs local only, or change the channel
import { createLogger, createElectronRendererRuntime } from 'lograil';

const log = createLogger({
  runtime: createElectronRendererRuntime({
    forwardToMain: true, // default — forward to main over IPC
    // channel: 'my-app:log',
  }),
});
```

| Factory                       | Option               | Effect                                         |
| ----------------------------- | -------------------- | ---------------------------------------------- |
| `createElectronMainRuntime`   | `appName`            | Derives the default log path                   |
| `createElectronMainRuntime`   | `logFile`            | Explicit rotating log file path                |
| `createElectronMainRuntime`   | `fileTransportOptions` | Forwarded to `RotatingFileTransport`         |
| `createElectronMainRuntime`   | `disableFile`        | Console only (no file)                         |
| `createElectronMainRuntime`   | `receiveFromRenderer` | Receive renderer logs over IPC (default `true`)| |
| `createElectronRendererRuntime` | `forwardToMain`    | Forward to main over IPC (default `true`)      |
| `createElectronRendererRuntime` | `channel`          | Override the IPC channel                       |

## The IPC channel

Both sides communicate on one channel, exported as a constant:

```ts
import { LOGRAIL_CHANNEL } from 'lograil'; // 'lograil:log'
```

If you override `channel`, set the **same** value on both the renderer runtime and
the main receiver. For full control, skip the runtime helpers and call
`registerIpcReceiver` yourself:

```ts
import { registerIpcReceiver, createElectronMainRuntime } from 'lograil';

const log = createLogger({ runtime: createElectronMainRuntime({ receiveFromRenderer: false }) });
const off = registerIpcReceiver((entry) => log.ingestEntry(entry), { channel: 'my-app:log' });
// off() stops listening
```

## End-to-end recap

```
renderer ──ElectronIpcTransport──▶ IPC ──▶ main: registerIpcReceiver
                                                     │
                                                     ▼
                                            log.ingestEntry(entry)
                                                     │
                                                     ▼
                              main: ConsoleTransport + RotatingFileTransport
```

- Renderer logs never touch disk directly — the main process persists them.
- Main-process logs and ingested renderer logs share one pipeline, one set of
  transports, and one rotating file.
- Level filtering and plugins apply uniformly to both.
