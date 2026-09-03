# 故障排查与 FAQ

针对最常见的"为什么看不到日志"场景，提供自查清单。

## 1. Console 输出导致无限递归 / 栈溢出

**现象：** 一打日志应用就卡死，或抛出 `Maximum call stack size exceeded`。

**原因：** 某个 transport（传输器，即日志的输出目的地）或 formatter（格式化器）/ plugin（插件）调用了 `console.log`/`console.error`，
而*你*通过 `redirectConsole()` 把 console 重定向进了 `lograil`。注意：`lograil` **默认不会**
重定向 `console.*`——只有你显式调用 `logger.redirectConsole()` 才会。被重定向的 `console.*`
又回调 logger → 死循环。

**自查**
- 是否调用了 `redirectConsole()`？如果是，它会接管 `console.*` 并重新经 logger 输出，你自己的
  transport（传输器）/插件**不要**对相同级别再调 `console.*`。若**未**调用它，请跳过本节——你的递归来自
  别处（例如某 transport 直接调用了 `console`）。
- 在 `onError` 或自定义 transport 内，请使用**原始** console（`console.error`）——
  `lograil` 特意保留了重定向前的引用；若你自己捕获了 `console`，改用 `process.stderr`
  或专门的 stderr sink（**sink** 即数据的最终目的地）。

**解决：** 在错误处理与自定义 sink 中写 `process.stderr`/文件，或改用不会回灌到被重定向
console 的 transport（传输器）。

## 2. 浏览器打包报错：无法解析 `node:fs` / `node:path` / `node:os`

**现象：** webpack / Vite / Rollup 在打包引入 `lograil` 的页面时报 `Module not found: Can't resolve 'node:fs'` 或 `Failed to resolve import "node:fs/promises"`。

**原因：** `lograil` 版本过旧。新版本从不直接解析 Node 内置模块——它们经过内部的 `shims` 层，构建时由 `browser` 字段替换为浏览器 stub，因此引入能顺利解析（打包器集成测试已验证）。

**修复：** 升级 `lograil` 到最新版。若已是最新版本仍报错，检查打包器是否关闭了 `browser` 映射，或是否从绕过 `browser` 字段的路径（如不走构建的 CDN）引入。

## 3. 渲染进程没有日志

**现象：** 主进程正常，渲染进程静默（或渲染日志始终到不了主进程的 `renderer.log` 文件）。

**背景：** 在默认的 Electron runtime（运行时）下这是**自动**的——渲染端 logger 会自动经 IPC（进程间通信）把日志
转发到主进程，主端 logger 会写到独立的 `renderer.{date}.log`。通常你什么都不用做。若仍不工作，
通常是以下之一：你主动退出了自动接线、用非 Electron 的 runtime 构造了 logger，或渲染端
无法访问 `electron` 模块而静默回退到 Web runtime。

**自查**
- 是否使用了默认的 `logger` / `createLogger()`（未显式传 `runtime`）？若是，转发与接收已由
  框架接好——无需手动添加 `ElectronIpcTransport` 或调用 `registerIpcReceiver`。
- 若你**主动退出**（`createElectronRendererRuntime({ forwardToMain: false })` 或
  `createElectronMainRuntime({ receiveFromRenderer: false })`）或用了自定义 runtime：是否在
  **渲染端**手动添加了 `ElectronIpcTransport`，并在**主进程**调用了
  `registerIpcReceiver((entry) => logger.ingestEntry(entry))`？
- channel 是否正确？两侧默认都是 `lograil:log`（`LOGRAIL_CHANNEL`）；若覆盖需**两侧**一致。
- 打包后 `contextIsolation: true` + `nodeIntegration: false` 的环境下，渲染端无法
  `require('electron')`，于是 lograil 无法识别 Electron 并回退到 Web runtime（仅本地 console）。
  用 preload 桥接，并通过 `createElectronRendererRuntime({ ipcRenderer })` 传入（见
  [Electron 指南](./runtime-electron.md)）。
- 临时把级别调低（`logger.setLevel('trace')`）排除级别过滤问题。

详见 [Electron 指南](./runtime-electron.md)。

## 4. OTLP 端点收不到任何数据

**现象：** 已添加 `OtlpTransport`，但 collector 里没有日志。

**自查**
- transport 所在进程能否访问该端点？（Electron 渲染进程的网络出口可能受限；建议从主进程
  发送，或用 `ElectronIpcTransport` 把渲染日志转发到主进程。）
- `OtlpTransport` 是**批量**发送的（`batchSize`，默认 100），异步 flush。快速验证可在运行
  结束时 `await logger.flush()`，或调小 `batchSize`。
- `fetch` 失败会通过 `onError` 上报（默认 `console.error`）。显式设置 `onError` 以查看
  HTTP/连接错误。
- 确认 collector URL：OTLP/HTTP JSON 期望 `…/v1/logs`。404/401 通常是路径或鉴权头错误。
- 防火墙 / 代理：请求就是普通 `fetch`，确保允许出网。

## 5. 日志文件不轮转

**现象：** 单个文件持续增大，或没有出现按日期的文件。

**自查**
- `FileTransport` 仅在具备 Node `fs` 的环境生效——即**主进程** / Node 运行时，而非
  浏览器或渲染进程 Web Worker。
- `rotate-time` 模式（默认）写入 `<appName>.{YYYY-MM-DD}.0.log`。检查日期戳格式与目录可写性；
  目录会自动创建（`mkdir -p`）。
- 轮转触发条件：写入将导致超过 `maxSize`（`rotate-size` / `single-truncate`），或跨越
  `hour`/`day` 边界（`rotate-time`），或你的 `shouldRotate` 谓词返回 `true`（`rotate-custom`）。
  `maxSize` 过小 / 写入量大时轮转会很频繁；请确认 `maxFiles` 允许保留多于一代。
- 文件句柄会在**第一次**真正写入日志时才打开。若从未打过日志，就不会创建文件——这是预期行为。

## 6. 日志乱序 / 在多个 transport 间重复

`lograil` 在多个 transport（传输器）间共享同一个不可变、冻结的条目（共享引用）。每个 transport（传输器）的异步
写入各有独立队列，因此慢 transport（传输器）可能落后于快 transport（传输器）——**顺序仅在单个 transport（传输器）内
保证**，而非跨 transport（传输器）全局保证。若需严格全局顺序，使用单一 transport（传输器）或让所有写入同步。
重复行通常是同一 transport（传输器）被加了两次，或 `redirectConsole()` 重复发出——用 `getTransports()`
核对。

## 7. 跨进程（IPC）传递时的注意事项

条目经 Electron IPC 发送时会做结构化克隆。条目越过边界后，在另一端是**全新的独立对象**。不要依赖对象同一性；
依赖字段值。详见[不可变性](./immutability.md)。
