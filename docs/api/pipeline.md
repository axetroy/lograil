# Pipeline

The pipeline turns a `LogEntry` into a formatted string via three stages:
**filters** (drop), **processors** (transform), and a **formatter** (serialize).

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

`createRedactProcessor` recursively redacts matching keys in `context` and
`metadata`.

## Formatter

```ts
type Formatter<T = string> = (entry: LogEntry) => T;

function createLineFormatter(): Formatter<string>;
function createJsonFormatter(): Formatter<string>;
```

- `createLineFormatter` — one human-readable line including the full `Error`
  cause chain.
- `createJsonFormatter` — structured JSON with `error` serialized via
  `errorToJson` (circular `cause` safe).

## Pipeline API

```ts
class Pipeline {
  constructor(options?: PipelineOptions);
  process(entry: LogEntry): LogEntry | null; // runs filters + processors
  addFilter(filter: Filter): void;
  removeFilter(filter: Filter): void;
  addProcessor(processor: Processor): void;
  removeProcessor(processor: Processor): void;
  setFormatter(formatter: Formatter): void;
  getFormatter(): Formatter;
}
```

`PipelineOptions` can be passed to `createLogger({ pipeline })` to configure the
pipeline declaratively:

```ts
interface PipelineOptions {
  filters?: Filter[];
  processors?: Processor[];
  formatter?: Formatter;
}
```

Access and mutate the active pipeline at runtime:

```ts
import { createRedactProcessor } from 'lograil';

logger.getPipeline().addProcessor(createRedactProcessor(['password']));
```
