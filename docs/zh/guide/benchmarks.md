# 基准测试

`lograil` 的设计目标之一是在热路径上保持极低开销。本页介绍如何自行测量吞吐量，
并记录我们为保持核心高性能所做的各项优化。

## 运行基准测试

基准测试基于 [vitest bench](https://vitest.dev/api/#benchmark) 编写，从仓库根目录运行：

```bash
npm run bench          # 或： npx vitest bench --run
```

每条用例报告的是 **hz（每秒操作数，越高越好）** 以及延迟分位数。基准套件通过配合
**空操作（no-op）传输器** 来把 logger 核心与传输层 I/O 隔离，因此数据反映的是
格式化、过滤与日志条目构建的开销，而非磁盘/控制台写入成本。

## 吞吐量（参考数据）

在 Node.js v24（x64）下，配合 no-op 传输器测得。数值会随机器与运行波动，请将其
视为**相对对比**而非硬性承诺。在你的机器上重新运行 `npm run bench` 可得到权威数据。

| 场景 | 吞吐量 |
| --- | --- |
| `emit` — 被过滤掉的 debug（提前返回） | ~19.5M ops/s |
| `emit` — `info` + identity 格式化器（无格式化开销） | ~3.0M ops/s |
| `emit` — `info` + 行格式化器 | ~1.46M ops/s |
| 行格式化器（单独调用） | ~1.96M ops/s |
| JSON 格式化器（单独调用） | ~1.23M ops/s |

## 我们做了哪些优化

库内置了若干热路径优化，且**全部保持行为不变**，仅提升性能。

1. **无插件时跳过异步路径。** 当没有任何插件注册 `onEntry` 拦截器时，`Logger`
   直接同步输出，完全绕开 `Promise`/写入队列机制（`PluginManager.hasEntryInterceptors()`
   判断 + 独立的 `dispatch` 分支）。这正是上表"被过滤掉"与"identity 格式化器"两行之间差距的来源。
2. **缓存合并后的过滤器。** `Pipeline` 将所有过滤器编译为单个合并谓词（`cachedFilter`）
   并复用，避免在每次日志上重复遍历过滤器列表。
3. **`safeStringify` 快速路径。** 纯 JSON 可序列化数据（对象/数组/基本类型，含 `undefined`）
   直接走原生 `JSON` 方法，跳过仅为处理 `Error`、循环引用与 `BigInt` 而存在的自定义
   replacer，使 JSON 格式化器在最常见场景下保持高速。
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
