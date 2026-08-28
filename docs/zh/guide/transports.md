# 传输器

**传输器（Transport）** 是日志条目的最终落点——控制台、文件、IPC，或你自己的目标。`Transport` 接口刻意保持精简：

```ts
interface Transport {
  /** 唯一名称，用于诊断与移除。 */
  readonly name: string;
  /** 可选的、覆盖管道默认值的每传输器格式化器。 */
  readonly formatter?: Formatter;
  /** 输出一条已处理的条目（同步或异步均可）。 */
  write(entry: LogEntry, formatted: string): void | Promise<void>;
  /** 可选：刷新，由 `logger.flush()` 等待。 */
  flush?(): void | Promise<void>;
  /** 可选：资源释放。 */
  close?(): void | Promise<void>;
}
```

## 内置传输器

### ConsoleTransport

写入全局 `console`，将每个级别映射到对应的方法（`warn` → `console.warn`，`error`/`fatal` → `console.error`，……）。

```ts
import { ConsoleTransport, createLineFormatter } from 'lograil';

new ConsoleTransport({
  name: 'console',
  formatter: createLineFormatter(),
  methodMap: { fatal: (...a) => console.error('FATAL', ...a) },
});
```

### RotatingFileTransport

面向 Node.js 与 Electron 主进程、带滚动能力的文件传输器。

```ts
import { RotatingFileTransport, createJsonFormatter } from 'lograil';

new RotatingFileTransport({
  path: '/var/log/app.log',
  daily: true, // 默认：每天一个带日期的文件
  maxFiles: 99, // 每日环形缓冲大小（默认 99 / 体积模式 5）
  maxSize: 10 * 1024 * 1024, // 体积模式的阈值（仅体积模式）
  formatter: createJsonFormatter(),
});
```

- **每日模式**（默认）：活动文件为 `app.{YYYY-MM-DD}.{01..maxFiles}.log`。当索引将要超过 `maxFiles` 时回绕到 `01` 并清空该文件——形成一个按天的环形缓冲。
- **体积模式**（`daily: false`）：经典的分代滚动 `app.log` → `app.1.log` → `app.2.log` …，当活动文件超过 `maxSize` 时触发。

### ElectronIpcTransport

渲染进程侧的传输器，通过 IPC 将每条条目转发到主进程。`electron` 模块采用惰性加载，因此在 Electron 之外导入也是安全的。

```ts
import { ElectronIpcTransport } from 'lograil';

const log = createLogger({
  runtime: createWebRuntime(), // 渲染进程没有文件系统
  transports: [new ElectronIpcTransport()],
});
```

在主进程中，启用 IPC 接收，以便渲染进程的日志被持久化：

```ts
import { createElectronMainRuntime, registerIpcReceiver } from 'lograil';

const log = createLogger({ runtime: createElectronMainRuntime() });
// 或直接使用默认主进程运行时（已自动挂载接收器）
```

## 自定义传输器

只需实现 `Transport` 接口即可：

```ts
import type { Transport, LogEntry } from 'lograil';

const httpTransport: Transport = {
  name: 'http',
  write(entry: LogEntry, formatted: string) {
    fetch('https://logs.example.com', {
      method: 'POST',
      body: formatted,
    });
  },
};
```

在运行时添加或移除传输器：

```ts
log.addTransport(httpTransport);
log.removeTransport('http');
```
