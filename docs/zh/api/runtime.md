# 运行时

运行时适配器将环境差异（时钟、进程 id、文件系统、默认传输器）隔离在单一接口之后。

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
   * 宿主生命周期钩子。提供时，Logger 会通过它们来接线“退出前 flush”与“崩溃记录”，
   * 而不是直接触碰 `process` / `window`，从而让每个运行时自行决定何时退出、并拥有
   * 自己的 `process.exit()`。在不需要响应宿主生命周期的运行时可省略（或留空）。
   * 内置适配器已提供：Node → process 事件，Electron 主进程 → `app` 的 `before-quit` /
   * `will-quit`，Web → `pagehide` / `visibilitychange`。
   */
  lifecycle?: LifecycleHooks;
}
```

## 生命周期钩子

`LifecycleHooks` 把 logger 与宿主解耦。logger 提供行为（带超时的 flush、以 `fatal`
记录崩溃），运行时拥有触发器：

```ts
interface LifecycleHooks {
  // 在宿主关闭前 flush 待写条目。返回一个注销函数。
  onFlushBeforeExit(cb: () => void | Promise<void>): () => void;
  // 可选：记录致命的宿主未捕获错误（仅 Node / Electron）。
  onUncaughtError?(cb: (err: unknown) => void | Promise<void>): () => void;
}
```

只有编写**自定义**运行时适配器时才需要实现它；内置的 `createNodeRuntime` /
`createWebRuntime` / `createElectronMainRuntime` / `createElectronRendererRuntime`
已经挂好了对应钩子，因此各平台开箱即用 `autoFlushOnExit` / `watchUncaughtErrors`。

## 探测

```ts
import { detectRuntime, createWebRuntime, createNodeRuntime, createElectronRuntime } from 'lograil/runtime';

detectRuntime(options?); // 自动探测：Electron → Node → Web
```

`detectRuntime` 的优先级为：

1. 当 `process.versions.electron` 存在时为 **Electron**；
2. 存在 Node 进程时为 **Node.js**；
3. 否则为 **Web**。

对于 Electron，你也可以显式指定：

```ts
import { createElectronMainRuntime, createElectronRendererRuntime } from 'lograil/runtime';

createElectronMainRuntime(options?);
createElectronRendererRuntime(options?);
```

## 默认传输器

| 运行时               | 默认传输器                                                  |
| -------------------- | ----------------------------------------------------------- |
| Web                  | `ConsoleTransport`                                          |
| Node.js              | `ConsoleTransport` + `FileTransport`（`rotate-time`，按日）        |
| Electron 主进程      | `ConsoleTransport` + `FileTransport`（`rotate-time`，按日），并接收渲染进程 IPC |
| Electron 渲染进程    | `ConsoleTransport`（经由 IPC 转发到主进程）                 |

## 选项

```ts
interface NodeRuntimeOptions {
  appName?: string; // FileTransport 必填；省略时从入口脚本推断
  fileTransportOptions?: Partial<Omit<RotateTimeOptions, 'mode'>>; // 透传给默认 `FileTransport`
  disableFile?: boolean;
}

interface ElectronMainRuntimeOptions {
  // 日志文件名始终包含应用名；固定目录：<appData>/Lograil
  fileTransportOptions?: Partial<Omit<RotateTimeOptions, 'mode'>>;
  disableFile?: boolean;
  receiveFromRenderer?: boolean; // 默认 true
}
```

可以通过 `detectRuntime` 或显式工厂函数传入选项：

```ts
createLogger({ runtime: createNodeRuntime({ appName: 'my-app', disableFile: false }) });
```

## 常量与类型

```ts
// 渲染进程 → 主进程日志所经由的 IPC 频道。
const LOGRAIL_CHANNEL: string; // 'lograil:log'

type RuntimeName = 'web' | 'node' | 'electron';
type ElectronProcessType = 'main' | 'renderer';
// 将收到的条目喂回 logger 的回调。
type IngestFn = (entry: LogEntry) => void;
```

`forwardToMain`、`channel` 与 `ipcRenderer` 专属于 `createElectronRendererRuntime`：

```ts
interface ElectronRendererRuntimeOptions {
  forwardToMain?: boolean; // 默认 true —— 通过 IPC 转发到主进程
  channel?: string;        // 覆盖 IPC 频道
  // 注入的 IPC 发送器。当渲染进程无法访问 require('electron') 时必须提供
  // （例如 nodeIntegration:false + contextIsolation:true）：用 preload 桥接
  // 暴露的 ipcRenderer，而非让传输器自己调用 require('electron')。
  ipcRenderer?: { send(channel: string, ...args: unknown[]): void };
}
```

提供 `ipcRenderer` 时直接使用它；否则传输器回退到
`require('electron').ipcRenderer`，而这在受限渲染进程中不可用。详见
[Electron 指南](/zh/guide/electron#安全配置preload-contextisolation) 中的 preload 模式。

`RuntimeName` / `ElectronProcessType` / `IngestFn` 属于 `RuntimeAdapter` 契约（见 [运行时适配器接口](/zh/api/runtime)），在编写自定义适配器或自定义 IPC 桥时很有用。
