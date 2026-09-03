# 不可变性与零拷贝

`lograil` 为高性能而生。核心做法是：**不在日志传递过程中反复复制数据**——
同一个进程里，所有传输器共用同一个日志对象；跨进程时也只打包一次。

## 日志对象交给传输器后就变成「只读」

一条日志（`LogEntry`）只在「刚创建」和「插件处理」这两个阶段可以被修改。
等到它要被各个传输器输出时，我们会用 `freezeEntry` 把它**冻结**（也就是变成只读）：

- 日志对象本身不能再被修改；
- 它的 `context`、`metadata`、`args` 这几个字段也不能再被修改；
- 不过，对象里嵌套的深层数据**不会**被一并锁死（否则每条日志都要多做一次深拷贝，反而拖慢性能）。

冻结之后，每个传输器、格式化器、插件读到的都是**同一个**对象。因为只读，
任何一个传输器都不可能不小心改坏别的传输器正在用的数据；你也可以用「传引用」
的方式（不复制）把它到处传递。

```ts
import { createLogger, freezeEntry } from 'lograil';

const logger = createLogger({ transports: [/* … */] });
// 日志在交给传输器之前会自动帮你冻结，通常你不需要手动调用。
```

如果你是自己构造日志对象（比如通过 `ingestEntry` 喂进来），也建议先冻结，
这样能得到同样的「不会被改坏」保证：

```ts
const frozen = freezeEntry(entry);
logger.ingestEntry(frozen);
```

插件和处理器遵循**「改之前先复制」**的原则：它们不会直接在原对象上改，而是
先复制出一份再改（返回 `{ ...entry, … }`）。这样既保住了原对象的只读性，
又让下一个环节可以继续共用同一份数据。

## 跨进程日志（Electron 渲染进程 → 主进程）

`ElectronIpcTransport` 负责把渲染进程的日志转发到主进程。它通过
`ipcRenderer.send()` 发送，Electron 内部会自动对消息做结构化克隆（即完整拷贝）。
这是简单可靠的做法；代价是每次发送大 `context` 时会复制整个对象图。
如需更高吞吐，可自行构建预序列化传输器，但内置传输器优先保证正确性与简单性。

```ts
// 渲染进程
logger.addTransport(new ElectronIpcTransport());

// 主进程——用默认的 Electron runtime 时，这个接收器已经自动注册好了，
// 只有当你主动关闭自动转发、或自己定制 runtime 时才需要手动调用 registerIpcReceiver。
import { registerIpcReceiver } from "lograil";
registerIpcReceiver((entry) => logger.ingestEntry(entry));
```
> 那一段二进制数据（`ArrayBuffer`）一旦「转移」出去，就归接收方所有了——发送之后
> 不要再读取或复用它。
