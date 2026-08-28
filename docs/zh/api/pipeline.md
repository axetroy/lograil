# 管道

管道通过三个阶段将 `LogEntry` 转换为格式化后的字符串：**过滤器**（丢弃）、**处理器**（转换）与 **格式化器**（序列化）。

## Filter

```ts
type Filter = (entry: LogEntry) => boolean;

function createLevelFilter(minLevel: number): Filter;
function createScopeFilter(allowed: string[]): Filter;
function createSampler(options?: SamplingOptions): Filter;
function combineFilters(filters: Filter[]): Filter;
```

### 采样（Sampling）

`createSampler` 通过丢弃条目来降低日志量，提供两种正交策略（按逻辑"与"组合）：

- **概率采样**（`rate`，0~1）：以 `rate` 的概率保留每条条目；
- **限速**（`maxPerSecond` + `burst`）：令牌桶限制每秒保留条数，允许短时突发。

不在 `levels` 内（或省略 `levels` 时对所有级别）的条目始终保留。由于它是过滤器，被采样的条目不会进入处理器、格式化器或传输器——这是高负载下降低成本最省力的方式。采样是有损的，请仅用于高量、低价值级别。

```ts
logger.getPipeline().addFilter(
  createSampler({ levels: ['debug', 'info'], maxPerSecond: 100, burst: 200 }),
);
```

## Processor

```ts
type Processor = (entry: LogEntry) => LogEntry;

const identityProcessor: Processor;

function createRedactProcessor(keys?: string[], replacement?: unknown): Processor;
const DEFAULT_SENSITIVE_KEYS: string[];
function createDefaultSerializers(): Record<string, Serializer>;
function createSerializeProcessor(serializers: Record<string, Serializer>): Processor;
```

`createRedactProcessor` 在**格式化之前**对敏感数据脱敏——它会遍历 `context`、`metadata` 以及 `args` 的每个元素，将路径匹配 `keys` 中任一项的值替换为 `replacement`（默认 `"[REDACTED]"`，可为任意值）。

- 裸键名（如 `'password'`）匹配任意深度下该名称的属性。
- 点路径（如 `'user.password'`）只匹配确切路径。
- `*` 匹配任意单个键/下标：`'*.password'` 脱敏所有 `password`，`'user.*'` 脱敏 `user` 下的全部直接子字段。

原始对象永不会被修改；仅真正包含匹配项的分支会被克隆，因此无匹配时条目会被原样返回。

`createRedactProcessor` 不传 `keys` 时，会对一组内置的常见机密 / PII 键脱敏——即 `DEFAULT_SENSITIVE_KEYS`（密码、token、API key、`authorization`、`cookie`、私钥、`sessionId`、`csrf`、`otp`、`ssn` 等）。传入显式列表会覆盖默认值。

### 序列化器（Serializers）

```ts
type Serializer = (value: unknown, entry: LogEntry) => unknown;
```

`createSerializeProcessor` 在**格式化之前**按属性名对值做**归一化**。只要在 `context`、`metadata`、`args` 的每个元素（以及条目的 `error`）中找到名为 `key` 的属性，就会用对应序列化器替换其值。它相当于 pino 的 `serializers`——可用它脱敏敏感字段、裁剪大对象，或统一渲染框架对象（请求、数据库行等）。

- 按属性名在**任意深度**匹配——任何带有 `req` 属性的对象都会触发 `req` 序列化器。
- 第二个参数会传入 `entry`，便于做带上下文的序列化。
- 转换是结构性的：仅包含匹配键的分支会被克隆；无匹配时条目原样返回。

`createDefaultSerializers()` 返回一组开箱即用的 `Serializer`，按所匹配的属性名命名（`error`、`date`、`buffer`、`url`、`req`、`res`）——例如错误变为 `{name,message,stack}`，`Date` → ISO 字符串，`Buffer` → `Buffer(n)`，URL → `href`，`req`/`res` 裁剪为 method/url/headers（或 status/headers）。可将其展开进你自己的映射：

```ts
logger.getPipeline().addProcessor(
  createSerializeProcessor({ ...createDefaultSerializers(), user: (u) => ({ id: u.id }) }),
);
```

```ts
import { createSerializeProcessor, createRedactProcessor } from 'lograil';

logger.getPipeline().addProcessor(
  createSerializeProcessor({
    err: (e) => ({ name: e.name, message: e.message, stack: e.stack }),
    user: (u) => ({ id: u.id }), // 只保留 id
  }),
);
```

建议把序列化器放在 `createRedactProcessor` **之前**，以便脱敏能进一步掩盖已归一化的输出。

#### 真实场景

一个 Web 服务要为每次请求记录日志。原始的 `req` / `user` 对象既庞大又容易泄密（headers、cookies、socket、密码哈希等）——用序列化器只保留需要的字段，再配合脱敏作为兜底：

```ts
const log = createLogger({
  pipeline: {
    processors: [
      createSerializeProcessor({
        // 只保留安全字段，丢弃 headers/cookies/socket
        req: (r: any) => ({ method: r.method, url: r.url, ip: r.ip }),
        // user 含 passwordHash，只暴露 id 与角色
        user: (u: any) => ({ id: u.id, role: u.role }),
        // 把错误展开成可读结构
        err: (e: any) => ({ name: e.name, message: e.message, stack: e.stack }),
      }),
      // 脱敏任何漏网的敏感字段
      createRedactProcessor(['token', 'authorization', 'cookie']),
    ],
  },
});

// 之后，在请求处理函数内：
log.info('request handled', { req, user, err });
```

输出的 JSON 行既实用又不会泄露机密：

```json
{
  "level": "info",
  "message": "request handled",
  "args": [
    {
      "req": { "method": "GET", "url": "/api/me", "ip": "203.0.113.7" },
      "user": { "id": 42, "role": "admin" }
    }
  ]
}
```

## Formatter

```ts
type Formatter<T = string> = (entry: LogEntry) => T;

function createLineFormatter(): Formatter<string>;
function createJsonFormatter(options?: { flatten?: boolean }): Formatter<string>;
```

- `createLineFormatter` —— 一行可读文本，包含完整的 `Error` 因果链。
- `createJsonFormatter` —— 结构化 JSON，其中 `error` 通过 `errorToJson` 序列化（对循环 `cause` 安全）。传入 `{ flatten: true }` 时，`context` 与 `metadata` 会被**拍平到对象顶层**（而非嵌套），便于 Loki、Elasticsearch 这类期望扁平字段的后端。

## Pipeline API

```ts
class Pipeline {
  constructor(options?: PipelineOptions);
  process(entry: LogEntry): LogEntry | null; // 运行过滤器 + 处理器
  addFilter(filter: Filter): void;
  removeFilter(filter: Filter): void;
  addProcessor(processor: Processor): void;
  removeProcessor(processor: Processor): void;
  setFormatter(formatter: Formatter): void;
  getFormatter(): Formatter;
}
```

`PipelineOptions` 可通过 `createLogger({ pipeline })` 传入，以声明式方式配置管道：

```ts
interface PipelineOptions {
  filters?: Filter[];
  processors?: Processor[];
  formatter?: Formatter;
}
```

在运行时访问并修改活动的管道：

```ts
import { createRedactProcessor } from 'lograil';

logger.getPipeline().addProcessor(createRedactProcessor(['password']));
```
