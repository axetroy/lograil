# 管道

管道通过三个阶段将 `LogEntry` 转换为格式化后的字符串：**过滤器**（丢弃）、**处理器**（转换）与 **格式化器**（序列化）。

## Filter

```ts
type Filter = (entry: LogEntry) => boolean;

function createLevelFilter(minLevel: number): Filter;
function createScopeFilter(allowed: string[]): Filter;
function combineFilters(filters: Filter[]): Filter;
```

## Processor

```ts
type Processor = (entry: LogEntry) => LogEntry;

const identityProcessor: Processor;

function createRedactProcessor(keys: string[], replacement?: string): Processor;
```

`createRedactProcessor` 会递归地对 `context` 与 `metadata` 中匹配的键进行脱敏。

## Formatter

```ts
type Formatter<T = string> = (entry: LogEntry) => T;

function createLineFormatter(): Formatter<string>;
function createJsonFormatter(): Formatter<string>;
```

- `createLineFormatter` —— 一行可读文本，包含完整的 `Error` 因果链。
- `createJsonFormatter` —— 结构化 JSON，其中 `error` 通过 `errorToJson` 序列化（对循环 `cause` 安全）。

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
