# Node 运行时

Node 运行时面向 CLI 工具、服务器、worker 和所有非 Electron 的 Node.js 进程。
它被自动探测，既有进程 id，也有文件系统访问权限。

> **另请参阅：** [Web 运行时](/zh/guide/runtime-web) · [Electron](/zh/guide/runtime-electron) ——
> 三个运行时共享相同的 API 面；本页涵盖 Node 特有的行为。

## 默认行为

```ts
import { logger } from 'lograil';

logger.info('server started', { port: 3000 });
```

当运行时解析为 Node 时，默认 `logger` 输出到：

1. **控制台**（`ConsoleTransport`）
2. **滚动文件**（`FileTransport`，模式 `rotate-time`，单位 `day`）

每日文件默认写入 `os.tmpdir()`（可通过 `fileTransportOptions: { dir }` 覆盖）。
`appName` 嵌入每个文件名，并决定该传输器管理的文件集合。

### 磁盘安全默认值

内置的 `FileTransport` 在开箱时即有上限——零配置的 logger 不会吃掉磁盘：

| 上限 | 默认值 | 限制内容 |
| --- | --- | --- |
| `maxSize` | 10 MB | 单文件大小（活动文件） |
| `maxFiles` | 14 | 保留的日文件数（约两周） |
| `maxTotalSize` | 200 MB | 所有属主文件的绝对磁盘上限 |

所有上限均可通过 `fileTransportOptions` 调整或放开：

```ts
import { createLogger, createNodeRuntime } from 'lograil';

const log = createLogger({
  runtime: createNodeRuntime({
    appName: 'my-server',
    fileTransportOptions: {
      dir: '/var/log/my-server', // 覆盖默认 tmpdir
      maxFiles: 30,              // 保留一个月的日文件
      maxTotalSize: 500 * 1024 * 1024, // 500 MB 上限
    },
  }),
});
```

## `appName`

每个 `FileTransport` 都需要一个 `appName`——它嵌入日志文件名（例如
`my-server.2026-08-31.log`），使文件可被识别出属于哪个应用。

- **显式指定：** 在运行时选项或 `fileTransportOptions` 中传入 `appName`。
- **自动推断：** 当 `appName` 省略时，`createNodeRuntime()` 从启动脚本
  （`process.argv[1]`）推导——例如 `node server.js` 得到 `appName: 'server'`。
  推断失败时（如在 REPL 中）运行时会抛错。

```ts
// 显式指定——库/worker 务必如此
createNodeRuntime({ appName: 'my-lib' });

// 自动推断——适用于 CLI 入口
createNodeRuntime(); // appName 从 process.argv[1] 推导
```

## `createNodeRuntime()`

需要自定义行为时使用 `createNodeRuntime()`——禁用文件传输器、更改目录、
或设置已知的应用名：

```ts
import { createLogger, createNodeRuntime } from 'lograil';

// 仅控制台——不写文件
const log = createLogger({
  runtime: createNodeRuntime({ disableFile: true }),
});
```

### 选项

| 选项 | 类型 | 作用 |
| --- | --- | --- |
| `appName` | `string` | 用于文件名的应用名；省略时自动推断 |
| `disableFile` | `boolean` | 仅控制台（默认 `false`） |
| `fileTransportOptions` | `Partial<RotateTimeOptions>` | 透传给 `FileTransport`（模式 `rotate-time`） |

`fileTransportOptions` 接受所有 `RotateTimeOptions` 字段（除了固定为
`rotate-time` 的 `mode` 和从顶层取值的 `appName`）：

```ts
createNodeRuntime({
  appName: 'worker',
  fileTransportOptions: {
    unit: 'hour',        // 每小时轮转（替代默认每日）
    maxFiles: 48,        // 保留 48 个小时文件
    fileName: (app, stamp, ext) => `${app}-${stamp}.${ext}`,
  },
});
```

## 退出时刷新

当 `autoFlushOnExit` 开启时（默认），logger 会自动注册 `beforeExit`、
`SIGINT` 和 `SIGTERM` 处理器。正常退出时事件循环会排空待写入的条目；
收到信号时，logger 会尽力刷新后退出（`SIGINT` 退出码 130，`SIGTERM` 退出码 143）。
该行为幂等，且在 Node 之外为空操作。

```ts
const log = createLogger({ autoFlushOnExit: true }); // 默认
// 或显式调用：
log.attachExitHandlers();
```
