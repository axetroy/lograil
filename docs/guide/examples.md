# Examples

Reusable, copy-pasteable recipes for plugins and custom loggers.

## Example plugins

### Enrich entries with environment metadata

A plugin that stamps every entry with the host, pid and a build id:

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

### Redact secrets

Reuse the built-in redactor through a configurable plugin:

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

### Sample high-volume logs

Drop a fraction of entries to control cost at scale. A `Filter` returning
`false` discards the entry before formatting:

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

await log.use(samplePlugin(0.1)); // keep ~10%
```

### Forward everything to a remote endpoint

A plugin that attaches an HTTP transport at init:

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

### Async audit plugin

`onEntry` may be async — here we write to a database before letting the entry
through:

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

## Custom logger

`createLogger` accepts a full `LoggerOptions` object, so a "custom logger" is
just a pre-configured instance. Build a factory for a production JSON logger:

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
      filters: [createLevelFilter(30)], // info and above
    },
    context: undefined,
  });
}
```

### Custom formatter

Supply your own `Formatter` to control the on-wire shape. The formatter receives
a `LogEntry` and returns a string (or any serializable value):

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

### Compose with plugins and scopes

The custom logger above can be further extended at runtime, and scoped for
request context:

```ts
const log = createProductionLogger({ appName: 'api', logFile: '/var/log/api.log' });

await log.use(redactPlugin(['session']));

// Per-request child logger with isolated context.
const reqLog = log.scope('http', { requestId: 'abc-123' });
reqLog.info('received'); // context carries requestId; redaction still applies
```

### Explicit runtime

For a browser-only build, or to pin the Node file location, pass a runtime:

```ts
import { createWebRuntime, createNodeRuntime } from 'lograil/runtime';

const webLog = createLogger({ runtime: createWebRuntime() });
const nodeLog = createLogger({
  runtime: createNodeRuntime({ appName: 'api', disableFile: false }),
});

## Production patterns

### Built-in sampling (recommended over a custom filter)

`createSampler` is the built-in, allocation-free way to cut volume. It combines
probabilistic sampling with a token-bucket rate limit (logical AND) and only
affects the levels you opt in:

```ts
import { createSampler } from 'lograil';

logger.getPipeline().addFilter(
  createSampler({ levels: ['debug', 'info'], maxPerSecond: 100, burst: 200 }),
);
```

(For a quick manual drop without the sampler, `createLevelFilter` or a custom
`Filter` also work — see the "Sample high-volume logs" plugin above.)

### Child loggers for request context

`child()` derives a logger that shares transports/pipeline but carries its own
context (captured at creation) and can override the level:

```ts
const reqLog = logger.child({ context: { requestId: req.id, tenant } });
reqLog.info('start'); // every entry carries requestId + tenant

// A noisy subsystem scoped to errors only:
const quiet = logger.child({ level: 'error' });
```

### OTLP with trace correlation

When an entry's context carries `traceId` / `spanId` (or `trace_id` / `span_id`),
`OtlpTransport` lifts them into OTLP's dedicated trace fields so the log joins the
same distributed trace in your backend:

```ts
import { OtlpTransport } from 'lograil';

logger.addTransport(
  new OtlpTransport({
    endpoint: 'http://localhost:4318/v1/logs',
    serviceName: 'checkout',
  }),
);

// somewhere per request, with your tracer's ids in context:
logger.child({ context: { traceId: span.spanContext().traceId } }).info('handled');
```

### Transport error handling

A transport can declare `onError` to be notified when its `write` fails, so a
broken sink is reported instead of crashing the caller:

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
```
