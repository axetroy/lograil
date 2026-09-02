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
  FileTransport,
  createRedactProcessor,
  createLevelFilter,
  type Logger,
} from 'lograil';

export function createProductionLogger(opts: {
  appName: string;
  dir?: string;
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
}): Logger {
  return createLogger({
    level: opts.level ?? 'info',
    transports: [
      new ConsoleTransport({ formatter: createLineFormatter() }),
      new FileTransport({
        mode: 'rotate-time',
        appName: opts.appName,
        dir: opts.dir,
        unit: 'day',
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
const log = createProductionLogger({ appName: 'api', dir: '/var/log' });

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

## 生产模式

### 内置采样（优于手写过滤器）

`createSampler` 是内置的采样器，几乎不额外占用内存，用来控制日志量。它把「按概率随机采样」和「令牌桶限速（一种常见的限流算法）」两种方式结合在一起（两个条件都满足时才采样），并且只对你指定的级别生效：

```ts
import { createSampler } from 'lograil';

logger.getPipeline().addFilter(
  createSampler({ levels: ['debug', 'info'], maxPerSecond: 100, burst: 200 }),
);
```

（若只想快速丢弃、不引入采样器，`createLevelFilter` 或自定义 `Filter` 也可——见上方"采样高量日志"插件。）

### 用子 logger 承载请求上下文

`child()` 派生出一个共享传输器/管道的 logger，但它携带自己的上下文（在创建时捕获），并可覆盖级别：

```ts
const reqLog = logger.child({ context: { requestId: req.id, tenant } });
reqLog.info('start'); // 每条日志都携带 requestId + tenant

// 某个嘈杂子系统，只保留 error 及以上：
const quiet = logger.child({ level: 'error' });
```

`child()` 是轻量的——它复用父 logger 的管道、插件、传输器与作用域过滤器，不会额外读取环境变量或检测运行时，因此可以安全地按请求调用。（只有根 logger 拥有共享资源；在子 logger 上调用 `destroy()` 不会销毁父 logger 的传输器与插件。）

### `printf` 风格的消息

作为对熟悉 Node `util.format` / `console.log` 的用户的便利，lograil 也支持 `printf` 占位符。但这**不是性能特性**——在 JS 里函数实参会先求值，所以 `logger.info('user %s', name)` 与 `logger.info(\`user ${name}\`)` 是等价的（两者都会保留结构化 `args`，且都不会跳过实参求值）。按你自己读着顺手的方式来选即可：

```ts
logger.info('user %s logged in', user.name);   // %s 字符串
logger.info('price %d', price);                 // %d 数字
logger.info('payload %j', data);                // %j JSON
logger.info('obj %o', data);                    // %o/%O 对象预览
logger.info('progress %s%%', pct);              // %% 字面量 '%'
// 未被消费的剩余参数仍保留为结构化数据：
logger.info('user %s', user.name, { requestId }); // => 消息 + { requestId }
// 没有占位符？消息原样保留，args 也原样透传：
logger.info('discount 50% off', { code: 'SALE' });
```

### 用 OTLP 关联调用链（trace）

当条目的上下文里带有 `traceId` / `spanId`（或 `trace_id` / `span_id`）时，`OtlpTransport` 会把它们填进 OTLP 专用的追踪字段，这样在后端的监控系统中，这条日志就能和同一次请求的调用链（trace）关联起来：

```ts
import { OtlpTransport } from 'lograil';

logger.addTransport(
  new OtlpTransport({
    endpoint: 'http://localhost:4318/v1/logs',
    serviceName: 'checkout',
  }),
);

// 在请求中，把追踪器得到的 id 放进上下文：
logger.child({ context: { traceId: span.spanContext().traceId } }).info('handled');
```

### 传输器错误处理

传输器可以声明 `onError`，在其 `write` 失败时收到通知，从而上报故障而非让调用方崩溃：

```ts
const sink: Transport = {
  name: 'flaky',
  onError(err, entry) {
    console.error('sink failed for', entry.message, err);
  },
  write(entry, formatted) {
    throw new Error('disk full');
  },
};
```

## 更多示例

### 分离 stdout / stderr

单个 `ConsoleTransport` 默认就把 `error`/`fatal` 路由到 `console.error`（stderr），
其余级别路由到 `console.log`（stdout）。要显式控制哪些级别进 stderr，用 `stderrLevels`：

```ts
import { ConsoleTransport, createLineFormatter } from 'lograil';

// error + fatal → stderr，其余 → stdout
logger.addTransport(
  new ConsoleTransport({ formatter: createLineFormatter(), stderrLevels: ['error', 'fatal'] }),
);
```

若要硬性拆成两个 sink（例如分别管道 stdout/stderr），用两个 transport 各自配 `level`：

```ts
import { ConsoleTransport } from 'lograil';

logger.addTransport(new ConsoleTransport({ name: 'out', level: 'warn' })); // <= warn → stdout
logger.addTransport(
  new ConsoleTransport({ name: 'err', stderrLevels: ['error', 'fatal'] }), // error/fatal → stderr
);
```

### 用环境变量覆盖级别

将 `levelEnvVar` 指向某个环境变量（默认 `LOG_LEVEL`），运维无需重新部署即可调整详细度。
`LOGRAIL_DEBUG`（可用 `scopeFilterEnvVar` 配置）则按 scope 过滤：

```ts
import { createLogger } from 'lograil';

const logger = createLogger({
  level: 'info',
  levelEnvVar: 'LOG_LEVEL', // 设置了就读取 process.env.LOG_LEVEL
  scopeFilterEnvVar: 'LOGRAIL_DEBUG', // 例如 LOGRAIL_DEBUG='app:*' 仅显示 app.* scope
});

// $ LOG_LEVEL=debug node app.js        → debug 及以上
// $ LOGRAIL_DEBUG='app:*' node app.js  → 仅匹配 app.* 的 scope
```

### 自动 OTel trace 注入

安装 `@opentelemetry/api` 后，`createOtelTracePlugin` 会把当前活跃 span 的 `traceId`/`spanId`
注入到每条条目的 `metadata`。配合 `OtlpTransport` 即可自动把日志与 trace 关联：

```ts
import { createLogger, OtlpTransport, createOtelTracePlugin } from 'lograil';

const logger = createLogger({
  transports: [new OtlpTransport({ endpoint: 'http://localhost:4318/v1/logs' })],
});
await logger.use(createOtelTracePlugin());

// 在已追踪的操作内部，活跃 span 会被自动拾取：
logger.info('handling request'); // metadata: { traceId, spanId }
```

（未安装 `@opentelemetry/api` 时该插件为空操作，零开销。）

### 传输器故障回退（primary → secondary）

包装一个主 transport，当它失败时把条目改投到备用 sink。包装器在首次收到主 transport
错误时切换到备用：

```ts
import { type Transport, type LogEntry } from 'lograil';

function withFailover(primary: Transport, secondary: Transport): Transport {
  let useSecondary = false;
  // 主 transport 通过 onError 上报失败；首次失败时切换。
  const primaryWrapped: Transport = {
    ...primary,
    onError(err, entry) {
      useSecondary = true;
      secondary.write(entry, JSON.stringify(entry)); // 尽力转发到备用
      primary.onError?.(err, entry);
    },
  };
  return {
    name: `failover(${primary.name}→${secondary.name})`,
    write(entry: LogEntry, formatted: string) {
      const sink = useSecondary ? secondary : primaryWrapped;
      return sink.write(entry, formatted);
    },
    flush: () => (useSecondary ? secondary.flush?.() : primary.flush?.()),
    close: () => (useSecondary ? secondary.close?.() : primary.close?.()),
  };
}

logger.addTransport(
  withFailover(
    new OtlpTransport({ endpoint: 'http://primary:4318/v1/logs' }),
    new ConsoleTransport(), // 远端不可用时回退
  ),
);
```
```
