# 基准测试

`lograil` 的设计目标之一是在高频调用路径上保持极低开销。本页介绍如何自行测量吞吐量，
并记录我们为保持核心高性能所做的各项优化。

## 运行基准测试

基准测试基于 [vitest bench](https://vitest.dev/api/#benchmark) 编写，从仓库根目录运行：

```bash
npm run bench          # 或： npx vitest bench --run
```

每条用例报告的是 **hz（每秒操作数，越高越好）** 以及延迟分位数（如 p50/p99）。基准套件通过配合
**什么都不做的空传输器** 来把 logger 核心与传输层 I/O 隔离，因此数据反映的是
格式化、过滤与日志条目构建的开销，而非磁盘/控制台写入成本。

## 吞吐量（参考数据）

在 Node.js v24（x64）下，配合 no-op 传输器测得。数值会随机器与运行波动，请将其
视为**相对对比**而非硬性承诺。在你的机器上重新运行 `npm run bench` 可得到权威数据。

| 场景 | 吞吐量 |
| --- | --- |
| `emit` — 被过滤掉的 debug（提前返回） | ~19.5M ops/s |
| `emit` — `info` + 原样格式化器（identity）（无格式化开销） | ~3.0M ops/s |
| `emit` — `info` + 行格式化器 | ~1.46M ops/s |
| 行格式化器（单独调用） | ~1.96M ops/s |
| JSON 格式化器（单独调用） | ~1.23M ops/s |

## 与 `pino` 的对比

`pino` 是**纯 Node.js** 场景下极快的标杆日志库。`lograil` 面向不同场景——Electron
（主进程 + 渲染进程）与 Web——因此单纯的纯 Node 吞吐比拼只是故事的一半。下表是**能力**
对比；要拿原始 ops/s 对比，请在本机运行 `npm run bench` 并与 `pino` 比较。

| 维度 | `lograil` | `pino` |
| --- | --- | --- |
| 运行时 | Electron 主进程、Electron 渲染进程、Web、Node | 仅 Node |
| 跨进程日志 | 一等公民（`ElectronIpcTransport`，零拷贝转移） | 需自行 IPC |
| 结构化 `context`/`metadata` + `args` | 内置，冻结不可变条目 | 绑定对象 / `child` 绑定 |
| 处理器 / 插件管道 | 内置（`Filter`/`Processor`/`Plugin`） | 经 transports / 自定义 |
| 内置脱敏与序列化器 | `createRedactProcessor` / `createDefaultSerializers` | `pino-secret` / 自定义 |
| OTel trace 关联 | `createOtelTracePlugin` | 外部方案 |
| 格式 | JSON（`flatten` 选项）+ 行格式 | JSON、pretty、自定义 |
| 纯 Node 吞吐 | 很快（见上表） | 通常更快（C 层缓冲） |
| 浏览器 / 打包安全 | 是（Node 内置模块经 `shims` 层 + `browser` 字段替换为 stub；并有打包器集成测试验证） | 否 |

### 如何选型

- **选 `pino`：** 仅从 Node 服务端打日志，绝不碰 Electron/浏览器，且要绝对最大的原始吞吐、
  最少机制。
- **选 `lograil`：** 只要你需要以下任意一项——Electron 主↔渲染日志转发、Web 运行时支持、
  结构化 `context`/`metadata` 模型、插件/处理器管道、内置脱敏与序列化器、OTel trace 关联，
  或带冻结不可变条目契约的异步每-transport 队列。

也可以混用：高频调用路径的 Node 服务用 `pino`，与其通信的 Electron 外壳用 `lograil`。

## 这些结果的发布位置

上面的数字已写入本页，并**随文档一同发布**——每次 `yarn docs:build`（以及每次发版部署的
版本化文档）都包含它们。要更新，运行 `npm run bench`，把 `hz`/延迟输出贴回本表即可。它们
刻意做成**参考值**：请在本机重跑以获得权威数字。

## 我们做了哪些优化

库内置了若干高频调用路径优化，且**全部保持行为不变**，仅提升性能。

1. **无插件时跳过异步路径。** 当没有任何插件注册 `onEntry` 拦截器时，`Logger`
   直接同步输出，完全绕开 `Promise`/写入队列机制（`PluginManager.hasEntryInterceptors()`
   判断 + 独立的 `dispatch` 分支）。这正是上表"被过滤掉"与"原样格式化器（identity）"两行之间差距的来源。
2. **缓存合并后的过滤器。** `Pipeline` 将所有过滤器编译为单个合并后的过滤条件（`cachedFilter`）
   并复用，避免在每次日志上重复遍历过滤器列表。
3. **`safeStringify` 快速路径。** 纯 JSON 可序列化数据（对象/数组/基本类型，含 `undefined`）
   直接走原生 `JSON` 方法，跳过仅为处理 `Error`、循环引用与 `BigInt` 而存在的自定义
   替换函数，使 JSON 格式化器在最常见场景下保持高速。
4. **行格式化器中的 `isEmptyRecord`。** 用廉价的 `for…in` 存在性判断来决策是否渲染
   `context`/`metadata`，取代会分配数组并遍历的 `Object.keys(ctx).length`。
5. **共享冻结的空上下文。** 当 store 为空时，`ContextStore.get()` 返回同一个共享的冻结
   空对象，避免在高频率的"无上下文"路径上做逐次克隆与分配，且调用方无法修改它。
6. **时间戳复用单个 `Date`。** `buildEntry` 通过复用的单个 `Date`（读取 UTC 字段）来格式化
   ISO-8601 时间戳，因此每条日志都不会新分配 `Date` 对象，仅构建最终字符串。

## 尽早过滤是最划算的优化

最大的单项提速其实是不打日志：级别门槛在流水线之前运行，低于当前阈值的 `debug`
调用会被直接丢弃。生产环境请尽可能把日志级别调高。

```ts
import { logger } from 'lograil';

logger.setLevel('warn'); // info/debug 永远不会进入流水线
```
