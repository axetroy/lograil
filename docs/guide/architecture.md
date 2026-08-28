# Architecture

`lograil` is organized in layers so each concern stays isolated and
testable. A log call flows through them in a predictable order.

## Layers

```
  log.info(message, ...args)
          │
          ▼
   ┌───────────────┐
   │   Logger      │  builds a structured LogEntry (timestamp, scope,
   │  (facade)     │  context, metadata, error, level)
   └───────────────┘
          │
          ▼
   ┌───────────────┐
   │   Pipeline     │  1. Filters  — drop entries (e.g. by level/scope)
   │                │  2. Processors — transform/enrich/redact
   │                │  3. Formatter — serialize to string/JSON
   └───────────────┘
          │
          ▼
   ┌───────────────┐
   │  Plugins      │  intercept each entry asynchronously (may drop/modify),
   │               │  and can add transports / reshape the pipeline at runtime
   └───────────────┘
          │
          ▼
   ┌───────────────┐
   │  Transports   │  final sinks: console, rotating file, IPC, custom
   └───────────────┘
          ▲
          │
   ┌───────────────┐
   │  Runtime       │  isolates env differences (clock, pid, fs, defaults)
   │  Adapter       │  — auto-detected, or supplied explicitly
   └───────────────┘

   Context  — persistent structured fields attached to every entry.
```

- **Logger** turns a call into a `LogEntry`. The first argument may be a
  `string`, an `Error`, or any value (objects are kept structured).
- **Pipeline** runs `Filter`s (returning `false` drops the entry), then
  `Processor`s (in order, for enrichment/redaction), then a `Formatter` that
  produces the on-wire representation.
- **Plugins** run after the pipeline via an async `intercept` hook per entry.
  They can drop an entry (return `null`) or rewrite it, and they receive a
  `PluginContext` to reconfigure the logger at runtime.
- **Transports** are the sinks. A transport's `write` may be async; when it is,
  the logger awaits it during `flush()` / `destroy()`.
- **Runtime Adapter** abstracts the environment (Web / Node / Electron), so the
  same logger code runs everywhere.
- **Context** is merged into every entry's `context` field; scoped loggers get an
  isolated child context.

## Asynchrony & lifecycle

Logging is synchronous from the caller's perspective, but writes are drained
through an internal queue so async transports and plugin interception never block
your code:

```ts
logger.info('done'); // returns immediately
await logger.flush(); // wait until the queue (incl. async writes) is empty
await logger.destroy(); // flush, tear down plugins, close transports
```

Because plugin `onEntry` hooks are awaited and chained, and async transport
writes are queued, calling `flush()` (or `destroy()`) before process exit
guarantees no buffered logs are lost.

## Where filtering happens

There are two independent gates:

1. **Level gate** — both `setLevel` on the logger and `createLevelFilter` in the
   pipeline drop entries below a threshold. The logger-level gate runs first, so
   cheaply-discarded entries never enter the pipeline.
2. **Pipeline filters** — arbitrary predicates (`createScopeFilter`,
   `combineFilters`, custom) run inside the pipeline after the level gate.

## Why it's structured this way

- **Separation**: formatting and destination are decoupled — one entry can go to
  the console and a file with different formats.
- **Composability**: filters/processors/transports are plain functions/objects,
  easy to unit test and reuse.
- **Extensibility**: plugins can reshape the pipeline and add sinks at runtime
  without touching application code.
- **Portability**: the runtime adapter means the same API works in Web, Node and
  Electron, including the renderer→main log aggregation in Electron.
