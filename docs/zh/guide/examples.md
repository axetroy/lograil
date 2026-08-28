# 示例

可直接复制使用的插件与自定义 logger 配方。

## 示例插件

### 用环境元数据丰富日志

一个给每条日志打上 host、pid 与构建号的插件：

```ts
import os from 'node:os';
import { createLogger, type Plugin } from 'lograil';

const envPlugin: Plugin = {
  name: 'env',
  onEntry(entry) {
    entry.metadata = {
      ...entry.metadata,
      host: os.hostname(),
      pid: process.pid,
      build: process.env.BUILD_ID ?? 'dev',
    };
    return entry;
  },
};

const log = createLogger();
await log.use(envPlugin);
```

### 脱敏敏感字段

通过插件复用内置的脱敏处理器：

```ts
import { createRedactProcessor, type Plugin } from 'lograil';

function redactPlugin(keys: string[], replacement = '[REDACTED]'): Plugin {
  const processor = createRedactProcessor(keys, replacement);
  return {
    name: 'redact',
    onInit(ctx) {
      ctx.pipeline.addProcessor(processor);
    },
  };
}

await log.use(redactPlugin(['password', 'token', 'authorization']));
```

### 对高容量日志采样

丢弃一部分条目以控制规模。返回 `false` 的 `Filter` 会在格式化之前丢弃该条目：

```ts
import { type Filter, type Plugin } from 'lograil';

function samplePlugin(rate: number): Plugin {
  const filter: Filter = () => Math.random() < rate;
  return {
    name: 'sample',
    onInit(ctx) {
      ctx.pipeline.addFilter(filter);
    },
  };
}

await log.use(samplePlugin(0.1)); // 保留约 10%
```

### 把日志转发到远端

在初始化时挂载一个 HTTP 传输器的插件：

```ts
import { type Transport, type Plugin } from 'lograil';

function remotePlugin(url: string): Plugin {
  const transport: Transport = {
    name: 'remote',
    write(entry, formatted) {
      fetch(url, { method: 'POST', body: formatted }).catch(() => {});
    },
  };
  return {
    name: 'remote',
    onInit(ctx) {
      ctx.addTransport(transport);
    },
    onDestroy() {
      ctx.removeTransport('remote');
    },
  };
}

await log.use(remotePlugin('https://logs.example.com/ingest'));
```

### 异步审计插件

`onEntry` 可以是异步的——下面的例子在出错时写入数据库再放行：

```ts
import { type Plugin } from 'lograil';

const auditPlugin: Plugin = {
  name: 'audit',
  async onEntry(entry) {
    if (entry.levelName === 'error') {
      await db.auditLogs.create({ message: entry.message, meta: entry.metadata });
    }
    return entry;
  },
};
```

## 自定义 logger

`createLogger` 接收完整的 `LoggerOptions`，因此「自定义 logger」本质上就是一个预先配置好的实例。下面构建一个生产环境 JSON 日志工厂：

```ts
import {
  createLogger,
  createJsonFormatter,
  createLineFormatter,
  ConsoleTransport,
  RotatingFileTransport,
  createRedactProcessor,
  createLevelFilter,
  type Logger,
} from 'lograil';

export function createProductionLogger(opts: {
  appName: string;
  logFile: string;
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
}): Logger {
  return createLogger({
    level: opts.level ?? 'info',
    transports: [
      new ConsoleTransport({ formatter: createLineFormatter() }),
      new RotatingFileTransport({
        path: opts.logFile,
        daily: true,
        formatter: createJsonFormatter(),
      }),
    ],
    pipeline: {
      processors: [createRedactProcessor(['password', 'token'])],
      filters: [createLevelFilter(30)], // info 及以上
    },
  });
}
```

### 自定义格式化器

提供自己的 `Formatter` 来控制输出形态。格式化器接收 `LogEntry`，返回字符串（或任意可序列化值）：

```ts
import { type Formatter, type LogEntry } from 'lograil';

const logfmt: Formatter<string> = (e: LogEntry) =>
  [
    `time=${e.time}`,
    `level=${e.levelName}`,
    e.scope ? `scope=${e.scope}` : '',
    `msg=${JSON.stringify(e.message)}`,
  ]
    .filter(Boolean)
    .join(' ');

new ConsoleTransport({ formatter: logfmt });
```

### 配合插件与作用域组合

上面的自定义 logger 还可以在运行时进一步扩展，并按请求上下文派生作用域 logger：

```ts
const log = createProductionLogger({ appName: 'api', logFile: '/var/log/api.log' });

await log.use(redactPlugin(['session']));

// 每个请求一个带有隔离上下文的子 logger。
const reqLog = log.scope('http', { requestId: 'abc-123' });
reqLog.info('received'); // 上下文携带 requestId；脱敏依旧生效
```

### 显式指定运行时

对于纯浏览器构建，或要固定 Node 文件位置，可以传入运行时：

```ts
import { createWebRuntime, createNodeRuntime } from 'lograil/runtime';

const webLog = createLogger({ runtime: createWebRuntime() });
const nodeLog = createLogger({
  runtime: createNodeRuntime({ appName: 'api', disableFile: false }),
});
```
