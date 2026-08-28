# Electron

`lograil` 为 Electron 的双进程模型而生，并且 **开箱即用**：直接导入默认的 `logger` 即可，它在主进程与渲染进程中都能正确工作。通常你不需要 `createLogger`，也不需要任何运行时配置。

## 零配置（推荐）

### 主进程

```ts
// main.ts
import { app, BrowserWindow } from 'electron';
import { logger } from 'lograil';

app.whenReady().then(() => {
  const win = new BrowserWindow({ /* ... */ });
  win.loadFile('index.html');

  logger.info('app ready'); // → 控制台 + 每日滚动文件
});
```

仅此而已。主进程会输出到控制台 **和** `<appData>/Lograil/` 下的每日滚动文件（分别为 `main.{YYYY-MM-DD}.{01-99}.log` 与 `renderer.{YYYY-MM-DD}.{01-99}.log`），并自动通过 IPC 接收渲染进程发来的日志。

### 渲染进程

```ts
// renderer.ts
import { logger } from 'lograil';

logger.warn('UI 中发生了一些事');
// → 本地控制台，并经由 IPC 转发到主进程
```

默认的渲染进程 logger 会写入本地控制台（在 DevTools 中可见），并把条目转发到主进程，最终落到 **独立** 的 `renderer.{YYYY-MM-DD}.{01-99}.log` 文件中——与主进程的 `main.{YYYY-MM-DD}.{01-99}.log` 相互分离。

无需配置，无需 `createLogger`，无需任何接线。

## ⚠️ 注意：渲染进程必须能访问 Electron

要让「渲染进程 → 主进程」的转发生效，**渲染进程必须能够访问 `electron` 模块**（`require('electron')`）。

现代 Electron 默认关闭了 `nodeIntegration` 并启用了 `contextIsolation`，因此渲染进程的主世界（main world）**没有 `require`，也没有 Node 全局对象**（包括 `process`）。在这种情形下，`lograil` 无法在渲染进程中探测到 Electron，会**静默回退到 Web 运行时**——日志只打印到控制台，不会到达主进程。

在渲染进程中启用 Node（最简单的方式）：

```ts
new BrowserWindow({
  webPreferences: {
    nodeIntegration: true,
    // contextIsolation: false, // 某些配置下需与 nodeIntegration 一起关闭
  },
});
```

> 安全提示：`nodeIntegration: true` 会降低隔离性。生产环境更推荐用一个 `preload` 脚本只暴露 `ipcRenderer` 并自定义桥接，或仅为受信任的内容启用 Node 集成。库的降级是安全的——若无法访问 `electron`，它只会在本地打印日志并丢弃 IPC 发送。

## 安全配置（preload + contextIsolation）

在 Electron 推荐的安全默认值下（`nodeIntegration: false`、`contextIsolation: true`），渲染进程的主世界 **没有 `require`，也没有 `process`**，因此库内置的 `ElectronIpcTransport`（内部调用 `require('electron')`）无法访问 `ipcRenderer`。解决办法是借助一个 **preload** 脚本通过 `contextBridge` 暴露一个精简的 `send` 函数，再用一个自定义传输器来调用它。无需改动库本身——只用公开 API（`addTransport` + `LOGRAIL_CHANNEL`）即可。

**preload.ts**（运行在特权上下文，拥有 `require`）：

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronLogger', {
  send: (channel: string, data: unknown) => ipcRenderer.send(channel, data),
});
```

在窗口上启用该 preload：

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

**main.ts** —— 默认的 `logger` 已经会自动接收渲染进程的日志；若想更显式也可以这样写：

```ts
import { logger, registerIpcReceiver } from 'lograil';

registerIpcReceiver((entry) => logger.ingestEntry(entry));
```

**renderer.ts** —— 把 preload 桥接作为 `ipcRenderer` 注入，构建渲染进程 logger。这是第一方推荐方式，无需手写传输器：

```ts
import { createLogger, createElectronRendererRuntime } from 'lograil';

declare global {
  interface Window {
    electronLogger?: { send: (channel: string, data: unknown) => void };
  }
}

// 桥接只在 preload 运行后才存在；缺失时回退为普通（仅控制台）logger
const log = window.electronLogger
  ? createLogger({
      runtime: createElectronRendererRuntime({ ipcRenderer: window.electronLogger }),
    })
  : createLogger();

log.warn('UI 事件'); // → 控制台 + 经 preload 桥接转发到主进程
```

如果你更想保留默认的 `logger` 单例，也可以把桥接注册成一个传输器：

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

两种方式都会在渲染进程保留一条控制台日志（DevTools 可见），同时满足 Electron 的安全默认值。

## 自定义（进阶）

只有当你想修改日志路径、关闭文件，或停止接收渲染进程日志时，才需要使用 `createLogger` + 显式运行时。

```ts
// main.ts —— 关闭文件 / 停止接收渲染进程日志
import { createLogger, createElectronMainRuntime } from 'lograil';

const log = createLogger({
  runtime: createElectronMainRuntime({
    // 日志文件路径固定：<appData>/Lograil/{main,renderer}.log
    receiveFromRenderer: true, // 默认 —— 通过 IPC 接收渲染进程日志
  }),
});
```

```ts
// renderer.ts —— 仅本地日志，或更换频道
import { createLogger, createElectronRendererRuntime } from 'lograil';

const log = createLogger({
  runtime: createElectronRendererRuntime({
    forwardToMain: true, // 默认 —— 通过 IPC 转发到主进程
    // channel: 'my-app:log',
  }),
});
```

| 工厂                            | 选项                  | 作用                                           |
| ------------------------------- | --------------------- | ---------------------------------------------- |
| `createElectronMainRuntime`     | `fileTransportOptions` | 透传给 `RotatingFileTransport`                 |
| `createElectronMainRuntime`     | `disableFile`         | 仅控制台（不写文件）                           |
| `createElectronMainRuntime`     | `receiveFromRenderer` | 通过 IPC 接收渲染进程日志（默认 `true`）       |
| `createElectronRendererRuntime` | `forwardToMain`       | 通过 IPC 转发到主进程（默认 `true`）           |
| `createElectronRendererRuntime` | `channel`             | 覆盖 IPC 频道                                  |

## IPC 频道

两端通过一个频道通信，该常量已导出：

```ts
import { LOGRAIL_CHANNEL } from 'lograil'; // 'lograil:log'
```

如果你覆盖了 `channel`，需在渲染进程运行时与主进程接收端设置 **相同** 的值。若要完全掌控，可以跳过运行时辅助函数，自行调用 `registerIpcReceiver`：

```ts
import { registerIpcReceiver, createElectronMainRuntime } from 'lograil';

const log = createLogger({ runtime: createElectronMainRuntime({ receiveFromRenderer: false }) });
const off = registerIpcReceiver((entry) => log.ingestEntry(entry), { channel: 'my-app:log' });
// off() 停止监听
```

## 端到端流程

```
renderer ──ElectronIpcTransport──▶ IPC ──▶ main: registerIpcReceiver
                                                     │
                                                     ▼
                                            log.ingestEntry(entry)
                                                     │
                                                     ▼
                              main: ConsoleTransport + RotatingFileTransport
```

- 渲染进程日志不会直接落盘——由主进程负责持久化。
- 主进程自身的日志与被接收的渲染进程日志，共享同一条管道、同一组传输器、同一个滚动文件。
- 级别过滤与插件对两者统一生效。
