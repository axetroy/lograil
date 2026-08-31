# 快速开始

## 安装

::: code-group

```bash [npm]
npm install lograil
```

```bash [yarn]
yarn add lograil
```

```bash [pnpm]
pnpm add lograil
```

```bash [bun]
bun add lograil
```

:::

## 快速上手

本包导出一个开箱即用的 `logger`，其运行时（Web / Node / Electron）会在导入时自动探测。无需任何配置即可直接记录日志：

```ts
import { logger } from 'lograil';

logger.info('server started', { port: 3000 });
logger.warn('low disk space', { freeMb: 120 });
logger.error(new Error('boom'));
```

在 **Node.js** 与 **Electron 主进程**中，默认 logger 除输出到控制台外，还会写入一个滚动文件。在 **Web** 与 **Electron 渲染进程**中则输出到控制台（在 Electron 环境下，渲染进程会通过 IPC 转发到主进程）。

## 浏览器构建与打包器

`lograil` **开箱即用地支持浏览器打包**。在 Web 页面中引入它——无论用 webpack、Vite、Rollup、esbuild 还是其他打包器——都无需额外配置：

- Node 内置模块（`node:fs`、`node:path`、`node:os`、`node:async_hooks`）从不被直接解析。它们被路由到内部的 `shims` 层，`package.json` 的 `browser` 字段会在构建时把该层替换为浏览器 stub。
- stub 保证了**引入**在任何环境下都能成功。运行时专属的能力仍需要真实宿主：在浏览器里调用 `FileTransport` 写文件会抛错（浏览器没有文件系统），环境上下文为空操作（见 [Context](/zh/api/context)）。

如果只需要控制台 + 远程传输器，用 `createWebRuntime()` —— 它完全绕开文件传输器：

```ts
import { createLogger, createWebRuntime } from 'lograil';

const log = createLogger({ runtime: createWebRuntime() });
```

## 结构化日志

第一个参数可以是字符串、`Error` 或任意值。对象会被保留为结构化数据，而不会被强制转换成 `[object Object]`：

```ts
// Error 会被提取，并渲染其完整的 cause 因果链
logger.error(new Error('db failed'), { query: 'select * from users' });

// 普通对象会作为结构化参数保留
logger.info({ user: { id: 1 }, action: 'login' });
```

`Error` 的因果链（包含循环 `cause`）在可读行与 JSON 输出中均会被安全序列化。

## 作用域 Logger

可以派生出一个子 logger，它与父 logger 共享相同的传输器、管道与插件，但拥有自己的作用域（以 `:` 拼接）与隔离的上下文：

```ts
const http = logger.scope('http');

http.info('request received'); // scope: "http"
```

## 创建自定义实例

当你需要一个完全独立、可自定义的实例时，使用 `createLogger`：

```ts
import { createLogger } from 'lograil';

const log = createLogger({
  level: 'debug',
  transports: [/* ... */],
  context: /* ... */,
});
```

继续阅读 [配置](/zh/guide/configuration) 了解级别、上下文、传输器与管道。
