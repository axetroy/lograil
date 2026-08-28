# 不可变性与零拷贝

`lograil` 为高性能而生。一个核心设计是：**日志条目在送往传输器的过程中绝不拷贝**——
在同一进程内，同一个对象以引用方式被所有传输器共享；跨进程时只序列化一次。

## 不可变条目契约

一个条目（`LogEntry`）仅在「构建」和「插件运行」阶段可变。一旦它抵达传输器，
就会通过 `freezeEntry` 被**冻结**：

- `LogEntry` 对象本身被冻结；
- 其 `context`、`metadata`、`args` 容器被冻结；
- 嵌套值**不会**被深冻结（否则会在每条日志的热路径上重新引入拷贝）。

此后，每个传输器、格式化器、插件读取的都是**同一个**对象。因为它被冻结，任何传输器
都无法意外破坏其它传输器拿到的条目，你也可以放心地以引用方式传递它，无需克隆。

```ts
import { createLogger, freezeEntry } from 'lograil';

const logger = createLogger({ transports: [/* … */] });
// 条目在抵达传输器前会自动为你冻结。
```

如果你自行构建条目（例如喂给 `ingestEntry`），也冻结它以获得同样的保证：

```ts
const frozen = freezeEntry(entry);
logger.ingestEntry(frozen);
```

插件与处理器遵循**写时复制（copy-on-write）**原则：它们不原地修改条目，而是返回新对象
（`{ ...entry, … }`）。这样既保持原始条目不可变，又让下一阶段能以引用共享它。

## 跨进程边界的零拷贝（Electron IPC）

`ElectronIpcTransport` 把渲染进程的日志转发到主进程。Electron 的
`ipcRenderer.send(channel, entry)` 会在每次调用时**对整棵条目对象图做结构化克隆**——
对于大 context 而言开销显著。

为避免这一点，当 `postMessage` 可用时，该传输器会：

1. 将条目一次性序列化为 UTF-8 的 `ArrayBuffer`（`encodeEntry`）；
2. 通过 `postMessage(channel, buffer, [buffer])` **转移**缓冲区的所有权。

转移（transfer）是移动内存而非拷贝，因此热路径上唯一的额外工作就是在渲染进程编码一次、
在主进程解码一次。当 `postMessage` 不可用时，保留旧版 `send` 作为回退。

```ts
// 渲染进程
logger.addTransport(new ElectronIpcTransport());

// 主进程
import { registerIpcReceiver } from 'lograil';
registerIpcReceiver((entry) => logger.ingestEntry(entry));
```

> `ArrayBuffer` 是可转移对象。一旦发送即视为已被移动——之后不要读取或复用它。
