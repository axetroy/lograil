# Troubleshooting & FAQ

A self-check list for the most common "why am I not seeing logs?" situations.

## 1. Console output causes infinite recursion / stack overflow

**Symptom:** the app hangs or throws `Maximum call stack size exceeded` as soon as
you log.

**Cause:** a transport (or a formatter/plugin) calls `console.log`/`console.error`
while *you* have redirected the console into `lograil` via `redirectConsole()`.
Note: `lograil` does **not** redirect `console.*` by default — this only happens
when you explicitly call `logger.redirectConsole()`. The redirected `console.*`
calls back into the logger → loop.

**Check**
- Did you call `redirectConsole()`? If so, remember it captures `console.*` and
  re-emits them through the logger. Your own transports/plugins must **not** call
  `console.*` for the same levels. If you did **not** call it, skip this section —
  your recursion is coming from elsewhere (e.g. a transport calling `console`).
- Inside `onError` or a custom transport, use the **raw** console
  (`console.error`) — `lograil` deliberately keeps a pre-redirect reference for
  exactly this, but if you captured `console` yourself, use `process.stderr` or a
  dedicated stderr sink instead.

**Fix:** in error handlers and custom sinks, write to `process.stderr`/a file, or
use a transport that doesn't round-trip through the redirected console.

## 2. Renderer process produces no logs

**Symptom:** logging works in the main process but the renderer is silent (or
renderer logs never reach the main-process `renderer.log` file).

**Background:** with the default Electron runtime this is **automatic** — the
renderer logger forwards to the main process over IPC, and the main logger writes
a separate `renderer.{date}.log`. You normally do nothing. If it isn't working,
one of these is true: you opted out of the automatic wiring, you built the logger
with a non-Electron runtime, or the renderer can't reach the `electron` module and
silently fell back to the Web runtime.

**Check**
- Are you using the default `logger` / `createLogger()` (no explicit `runtime`)?
  If so, forwarding + receiving are wired for you — no `ElectronIpcTransport` or
  `registerIpcReceiver` call is needed.
- If you **opted out** (`createElectronRendererRuntime({ forwardToMain: false })`
  or `createElectronMainRuntime({ receiveFromRenderer: false })`) or use a custom
  runtime: did you manually add `ElectronIpcTransport` in the **renderer** and call
  `registerIpcReceiver((entry) => logger.ingestEntry(entry))` in the **main**?
- Is the channel correct? Both sides default to `lograil:log` (`LOGRAIL_CHANNEL`);
  if you override it, override on **both** sides.
- Packaged app with `contextIsolation: true` + `nodeIntegration: false`? The
  renderer can't `require('electron')`, so lograil can't detect Electron and falls
  back to the Web runtime (console only). Use a preload bridge and pass it via
  `createElectronRendererRuntime({ ipcRenderer })` (see the
  [Electron guide](./electron.md)).
- Rule out a level filter: `logger.setLevel('trace')` temporarily.

See the [Electron guide](./electron.md).

## 3. OTLP endpoint doesn't receive anything

**Symptom:** `OtlpTransport` is added but the collector shows no logs.

**Check**
- Is the endpoint reachable from the process that owns the transport? (In an
  Electron renderer the network egress may be restricted; prefer sending from the
  main process, or forward renderer logs via `ElectronIpcTransport`.)
- `OtlpTransport` **batches** (`batchSize`, default 100) and flushes
  asynchronously. For a quick test, call `await logger.flush()` at the end of your
  run, or lower `batchSize`.
- `fetch` failures are reported through `onError` (default: `console.error`). Add
  an explicit `onError` to see HTTP/connection errors.
- Confirm the collector URL: OTLP/HTTP JSON expects `…/v1/logs`. A 404/401 usually
  means the path or auth header is wrong.
- Firewall / proxy: the request is a normal `fetch`; ensure egress is allowed.

## 4. Log files aren't rotating

**Symptom:** a single file keeps growing, or no dated files appear.

**Check**
- `FileTransport` only works where the Node `fs` API exists — the
  **main** process / Node runtime, not a browser or renderer Web Worker.
- `rotate-time` mode (default) writes `<appName>.{YYYY-MM-DD}.log`. Check the date
  stamp format and that the directory is writable. The directory is created
  automatically (`mkdir -p`).
- Rotation triggers when a write would exceed `maxSize` (`rotate-size` / `single-truncate`),
  or cross the `hour`/`day` boundary (`rotate-time`), or when your `shouldRotate`
  predicate returns `true` (`rotate-custom`). A tiny `maxSize` / high volume makes
  rotation happen fast; verify `maxFiles` allows more than one generation.
- The file handle opens on the **first actual** write. If nothing is logged, no
  file is created — that's expected.

## 5. Logs appear out of order / duplicated across transports

`lograil` shares one immutable, frozen entry across all transports (zero-copy).
Per-transport async writes each have their own queue, so a slow transport may lag
behind a fast one — ordering is guaranteed **per transport**, not globally across
transports. If you need strict global order, use a single transport or make all
writes synchronous. Duplicate lines usually mean the same transport was added
twice, or `redirectConsole()` is double-emitting — check `getTransports()`.

## 6. Notes when passing entries across processes (IPC)

Entries are structured-cloned when sent over Electron IPC (the renderer transport
uses `postMessage` with a transferred `ArrayBuffer`, i.e. no copying). After an entry
crosses the boundary it is a **new, independent object** on the other side. Don't
rely on identity; rely on the field values. See
[Immutability & zero-copy](./immutability.md).
