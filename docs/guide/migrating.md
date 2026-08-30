# Migrating to lograil

This page maps common patterns from `electron-log`, `winston` and `pino` to
`lograil`, and calls out behavioral differences so you don't get surprised.

## From `electron-log`

Like `electron-log`, `lograil` is **zero-config in Electron** — a single
`createLogger()` (or the default `logger`) auto-detects whether it runs in the
main or renderer process and wires everything for you. There is **no** `transports`
to configure and **no** IPC wiring to write:

- In the **renderer**, logs go to the local console *and* are forwarded to the
  main process over IPC automatically.
- In the **main**, logs go to the console *and* a daily rotating file under
  the app's `logs` directory (`app.getPath('logs')`); renderer entries are
  received over IPC and written to a **separate** `renderer.{date}.log` so the
  two processes never mix.

| `electron-log` | `lograil` (zero-config default) |
| --- | --- |
| `log.info('hi', meta)` | `logger.info('hi', meta)` |
| `log.scope('worker')` | `logger.scope('worker', { /* ctx */ })` / `logger.child({ context })` |
| `log.transports.console.level = 'info'` | set `level` on the logger — the console transport is added automatically |
| `log.transports.file.fileName = 'app.log'` | automatic: `<logs>/main.log` (+ `renderer.log`) |
| `log.transports.console.format = '[{level}] {text}'` | `ConsoleTransport` formatter (override via a custom runtime) |
| `log.variables = { ... }` / `log.context` | `logger.setContext(key, value)` / `mergeContext` |
| `log.hooks.process` (rewrite entries) | a `Plugin` with `onEntry` |
| `log.transports.remote` (renderer→main) | **automatic** IPC forwarding — no code needed |

```ts
// main.ts and renderer.ts — identical, zero-config:
import { logger } from 'lograil';

logger.info('just works in both processes');
```

**Differences**
- `electron-log` hides the IPC hop behind fixed transports; `lograil` performs the
  same hop automatically via its Electron runtime, and only *surfaces* it when you
  opt into a custom runtime (see below). Both avoid copying (zero-copy) — see
  [Immutability & zero-copy](../guide/immutability.md).
- Levels are fixed (`trace…fatal`), not a configurable string map like electron-log.
  Map old names with `setLevel`.
- `lograil` separates `context` (persistent) from `metadata` (one-off) and
  **freezes** entries before they reach transports, so plugins/transports can't
  mutate shared state.

### Advanced: manual control (optional)

The automatic wiring can be turned off or replaced. Reach for this only when you
opt out (`forwardToMain: false` / `receiveFromRenderer: false`) or build the
logger with a non-Electron runtime:

```ts
// renderer — forward manually (instead of the default renderer runtime)
logger.addTransport(new ElectronIpcTransport());

// main — receive manually (instead of the default main runtime)
import { registerIpcReceiver } from 'lograil';
registerIpcReceiver((entry) => logger.ingestEntry(entry));
```

See the [Electron guide](../guide/electron.md) for the full zero-config flow and the
secure preload setup.

## From `winston`

`winston` composes `format.combine(...)` and transports per instance. `lograil`
uses a single pipeline (`Filter`/`Processor`/`Formatter`) plus transports.

| `winston` | `lograil` |
| --- | --- |
| `createLogger({ transports: [new transports.Console(), new transports.File()] })` | `createLogger({ transports: [new ConsoleTransport(), new FileTransport({ mode: 'rotate-time', appName, unit: 'day' })] })` |
| `logger.log('info', msg, meta)` | `logger.info(msg, meta)` |
| `format.combine(format.json(), …)` | `createJsonFormatter()` (or `createJsonFormatter({ flatten: true })`) |
| `format.timestamp()` / `format.colorize()` | built into `createLineFormatter()` |
| `logger.child({ module })` | `logger.scope(...)` / `logger.child({ context })` |
| `transports.Http` | `OtlpTransport` or a custom `fetch` transport |
| custom `Transport` subclass | implement the `Transport` interface (`write(entry, formatted)`) |

**Differences**
- `winston` formats per-transport via each transport's `format`. `lograil` formats
  **once** in the pipeline; a transport may override with its own `formatter`.
- `winston` `meta` becomes `lograil` `context`/`metadata`. `args` after the
  message are positional (`logger.info('msg', a, b)` → `entry.args = [a, b]`).
- `lograil`'s processors can normalize values (`createDefaultSerializers`) and
  redact secrets (`createRedactProcessor`) before formatting.

## From `pino`

`pino` is a Node-only, extremely fast raw logger. `lograil` trades a little raw
Node throughput for first-class **Web/Node/Electron** support, structured
context/metadata, a plugin pipeline, and zero-copy IPC.

| `pino` | `lograil` |
| --- | --- |
| `pino({ level })` | `createLogger({ level })` |
| `pino({ transport: { target: 'pino/file', options: { destination } } })` | `new FileTransport({ mode: 'rotate-time', appName, unit: 'day', dir })` |
| `pino-pretty` | `ConsoleTransport` + `createLineFormatter()` |
| `logger.child({ reqId })` | `logger.child({ context: { reqId } })` |
| `logger.info({ foo }, 'msg')` | `logger.info('msg', { foo })` (or `logger.child({ context: { foo } })`) |
| `pino.destination` / `sonic-boom` | `FileTransport` (Node `fs`) |
| `pino` transports (worker thread) | `ElectronIpcTransport` / `OtlpTransport` |

**Differences**
- `pino` runs only on Node. `lograil` runs on Electron main, Electron renderer
  (via `ElectronIpcTransport` to the main process), and the Web.
- `pino` is faster for pure Node throughput (C-level buffering). If you only log
  server-side and never touch Electron/browsers, `pino` is a fine choice.
- `lograil` adds: a processor/plugin pipeline, built-in redaction + serializers,
  OTel trace correlation (`createOtelTracePlugin`), namespace (module) filtering, and a
  frozen immutable entry contract.

## General mapping

| Concept | `lograil` API |
| --- | --- |
| emit | `logger.trace/debug/info/warn/error/fatal` |
| level control | `setLevel`, per-transport `level` |
| structured fields | `context` (persistent) / `metadata` (one-off) / `args` |
| child logger | `scope(name, ctx)` / `child({ context, level })` |
| hooks / middleware | `Plugin` (`onEntry`, `onInit`, `onTransport`, `onDestroy`) |
| sampling | `createSampler` (filter) |
| redaction | `createRedactProcessor` |
| custom sink | implement `Transport` |

See the [Transports](../guide/transports.md), [Pipeline](../api/pipeline.md) and
[Plugins](../guide/plugins.md) guides for the full surface.
