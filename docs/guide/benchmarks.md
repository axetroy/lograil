# Benchmarks

`lograil` is built to stay cheap on the hot path (the code that runs every time you log). This page explains how to
measure throughput yourself and documents the optimizations that keep the core
fast.

## Running the benchmarks

Benchmarks use [vitest bench](https://vitest.dev/api/#benchmark). Run them from
the repo root:

```bash
npm run bench          # or: npx vitest bench --run
```

Each case reports **hz** (operations per second) — higher is better — plus
latency percentiles. The suite isolates the logger core from transport I/O by
pairing the logger with a no-op (do-nothing) transport, so the numbers reflect formatting,
filtering and entry construction rather than disk/console cost.

## Throughput (indicative)

Measured on Node.js v24 (x64) with the no-op (do-nothing) transport. Numbers vary by machine
and will drift run to run — treat them as **relative** comparisons, not
guarantees. Rerun `npm run bench` on your own hardware for authoritative figures.

| Case | Throughput |
| --- | --- |
| `emit` — filtered-out debug (early return) | ~19.5M ops/s |
| `emit` — `info` + pass-through (identity) formatter (no format cost) | ~3.0M ops/s |
| `emit` — `info` + line formatter | ~1.46M ops/s |
| line formatter (standalone call) | ~1.96M ops/s |
| JSON formatter (standalone call) | ~1.23M ops/s |

## Comparison with `pino`

`pino` is the go-to ultra-fast logger for **pure Node.js**. `lograil` targets a
different envelope — Electron (main + renderer) and the Web — so a raw Node
throughput race is only half the story. The table is a **capability** comparison;
for raw ops/sec rerun `npm run bench` and compare against `pino` on your hardware.

| Dimension | `lograil` | `pino` |
| --- | --- | --- |
| Runtime | Electron main, Electron renderer, Web, Node | Node only |
| Cross-process logs | first-class (`ElectronIpcTransport`, zero-copy transfer) | needs manual IPC |
| Structured `context`/`metadata` + `args` | built-in, frozen immutable entry | bound objects / `child` bindings |
| Processor / plugin pipeline | built-in (`Filter`/`Processor`/`Plugin`) | via transports / custom |
| Built-in redaction & serializers | `createRedactProcessor` / `createDefaultSerializers` | `pino-secret` / custom |
| OTel trace correlation | `createOtelTracePlugin` | external |
| Formats | JSON (`flatten` option) + line | JSON, pretty, custom |
| Raw Node throughput | very fast (see table above) | typically faster (C-level buffering) |
| Browser / bundle-safe | yes (electron binding swapped for a stub) | no |

### When to choose which

- **Use `pino`** if you log only from a Node server, never touch Electron or the
  browser, and want the absolute maximum raw throughput with minimal machinery.
- **Use `lograil`** if you need any of: Electron main↔renderer log forwarding,
  Web runtime support, a structured `context`/`metadata` model, a plugin/processor
  pipeline, built-in redaction/serializers, OTel trace correlation, or async
  per-transport queues with a frozen immutable entry contract.

You can also mix: keep `pino` for a hot Node service and use `lograil` in the
Electron shell that talks to it.

## Where these results are published

The numbers above are committed to this page and **shipped with the docs** — every
`yarn docs:build` (and the versioned docs deployed on each release) includes them.
To refresh them, run `npm run bench` and paste the `hz`/latency output into this
table. They are intentionally *indicative*: rerun on your own hardware for
authoritative figures.

## What we optimized

The library ships with several hot-path optimizations. None change observable
behavior — they are all correctness-preserving.

1. **Skip the async plugin path when unused.** When no plugin registered an
   `onEntry` interceptor, `Logger` emits synchronously and bypasses the
   `Promise`/write-queue machinery entirely (`PluginManager.hasEntryInterceptors()`
   gate + a dedicated `dispatch`). This is what opens the gap between the
   "filtered-out" and "pass-through (identity) formatter" rows above.
2. **Cached combined filter.** `Pipeline` compiles all filters into a single
   combined filter condition (`cachedFilter`) and reuses it, so the pipeline avoids
   re-walking the filter list on every entry.
3. **`safeStringify` fast path.** Plain JSON-serializable data (objects/arrays/
   primitives; `undefined` included) is serialized with the native `JSON`
   methods and skips the custom replacement function that only exists to handle `Error`,
   circular refs and `BigInt`. This keeps the JSON formatter on the fast path
   for the common case.
4. **`isEmptyRecord` in the line formatter.** Instead of `Object.keys(ctx).length`
   (which allocates an array and iterates), the line formatter uses a cheap
   `for…in` presence check to decide whether to render `context`/`metadata`.
5. **Shared frozen empty context.** `ContextStore.get()` returns one shared
   frozen empty object when the store is empty, avoiding a per-call clone and
   allocation on the very common "no context" path. Callers cannot mutate it.
6. **Reused `Date` for timestamps.** `buildEntry` formats the ISO-8601 timestamp
   from a single reused `Date` (via UTC getters), so a log line never allocates a
   fresh `Date` object. Only the resulting string is built.

## Filtering early is the cheapest win

The biggest single speedup is simply not logging: the level gate runs before the
pipeline, so `debug` calls below the active threshold are dropped for free. Set
the level as high as your environment allows in production.

```ts
import { logger } from 'lograil';

logger.setLevel('warn'); // info/debug never enter the pipeline
```
