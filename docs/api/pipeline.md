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

function createRedactProcessor(keys: string[], replacement?: unknown): Processor;
```

`createRedactProcessor` redacts sensitive data **before** formatting — it walks
`context`, `metadata` and each element of `args`, replacing any value whose path
matches one of `keys` with `replacement` (default `"[REDACTED]"`; may be any value).

- A bare key, e.g. `'password'`, matches any property of that name at any depth.
- A dotted spec, e.g. `'user.password'`, matches only that exact path.
- `*` matches any single key/index: `'*.password'` redacts every `password`,
  `'user.*'` redacts everything directly under `user`.

The original objects are never mutated; only the branches that actually contain a
match are cloned, so when nothing matches the entry is returned unchanged.

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
