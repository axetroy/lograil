# Web 运行时

Web 运行时面向浏览器。它**没有文件系统**，没有进程 id，默认传输器只有
`ConsoleTransport`。

> **另请参阅：** [Node 运行时](/zh/guide/runtime-node) · [Electron](/zh/guide/runtime-electron) ——
> 三个运行时共享相同的 API 面；本页涵盖浏览器特有的行为。

## 默认行为

```ts
import { logger } from 'lograil';
```

在浏览器中，默认 `logger` 只输出到 `console`。没有文件传输器——不写磁盘、不轮转、数据不会离开浏览器。

## 哪些能用，哪些不能

| 功能 | Web |
| --- | --- |
| `console` 输出 | ✅ |
| 结构化 context / metadata | ✅ |
| Scope、filter、processor、formatter | ✅ |
| 插件 | ✅ |
| `maxLevel` / 级别守卫 | ✅ |
| `FileTransport` | ❌ 引入安全，但任何 `write()` 调用会抛错 |
| `attachExitHandlers()` | 空操作（无事件可挂载） |
| 环境异步上下文 | 空操作（见 [Context](/zh/api/context)） |
| `OtlpTransport` | ✅（需要 `fetch`——所有现代浏览器都支持） |

## `createWebRuntime()`

当你想显式指定（例如构建目标是浏览器），或者想完全跳过文件传输路径时，
使用 `createWebRuntime()`：

```ts
import { createLogger, createWebRuntime } from 'lograil';

const log = createLogger({ runtime: createWebRuntime() });
```

`createWebRuntime()` 返回一个 `RuntimeAdapter`，其特性：

- `hasFileSystem()` → `false`
- `pid()` → `0`
- `now()` → `Date.now()`
- `defaultTransports()` → `[new ConsoleTransport()]`
- 生命周期钩子在 `pagehide` / `visibilitychange` 时 flush（不依赖 `process` 事件）

## 浏览器构建与打包器

`lograil` **开箱即用地支持浏览器打包**。在 Web 页面中引入它——无论用
webpack、Vite、Rollup、esbuild 还是其他打包器——都无需额外配置：

- Node 内置模块（`node:fs`、`node:path`、`node:os`、`node:async_hooks`）从不被直接解析。
  它们经过内部的 `shims` 层，`package.json` 的 `browser` 字段在构建时把该层替换为浏览器
  stub，因此引入能顺利解析。
- stub 保证了**引入**在任何环境下都能成功。运行时专属的能力仍需真实宿主：浏览器里调用
  `FileTransport` 写文件会抛错，环境上下文为空操作（见 [Context](/zh/api/context)）。

如果只需要控制台 + 远程传输器，`createWebRuntime()` 完全跳过文件传输路径：

```ts
import { createLogger, createWebRuntime } from 'lograil';

const log = createLogger({ runtime: createWebRuntime() });
log.info('输出到控制台和/或 OTLP，不写磁盘');
```

## 覆盖 `now()`

时钟可注入——适用于测试或单调时间戳：

```ts
createWebRuntime({ now: () => performance.timeOrigin + performance.now() });
```
