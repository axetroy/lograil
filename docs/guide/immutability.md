# Immutability & zero-copy

`lograil` is built for high throughput. A core design choice is to **never copy
a log entry on its way to the transports** — within a process the same object is
shared by reference, and the cross-process hop serialises it exactly once.

## The immutable entry contract

An entry (`LogEntry`) is mutable only while it is being built and while plugins
run. The moment it reaches the transports it is **frozen** via `freezeEntry`:

- the `LogEntry` object itself is frozen;
- its `context`, `metadata` and `args` containers are frozen;
- nested values are *not* deep-frozen (that would reintroduce a copy on every
  log call).

From that point on, every transport, formatter and plugin reads the **same**
object. Because it is frozen, no transport can accidentally corrupt the entry
for the others, and you can safely hand it around without cloning.

```ts
import { createLogger, freezeEntry } from 'lograil';

const logger = createLogger({ transports: [/* … */] });
// Entries are frozen for you automatically before reaching a transport.
```

If you build entries yourself (e.g. to feed `ingestEntry`), freeze them to opt
into the same guarantees:

```ts
const frozen = freezeEntry(entry);
logger.ingestEntry(frozen);
```

Plugins and processors follow a **copy-on-write** discipline: instead of
mutating the entry in place they return a new object (`{ ...entry, … }`). That
keeps the original immutable and lets the next stage share it by reference.

## Zero-copy across the process boundary (Electron IPC)

`ElectronIpcTransport` forwards renderer logs to the main process. Electron's
`ipcRenderer.send(channel, entry)` would **structured-clone the whole entry
object graph** on every call — a real cost for large contexts.

To avoid that, when `postMessage` is available the transport:

1. serialises the entry once into a UTF-8 `ArrayBuffer` (`encodeEntry`), then
2. transfers the buffer's ownership with `postMessage(channel, buffer, [buffer])`.

Transferring moves the memory instead of copying it, so the only work on the
hot path is a single encode in the renderer and a single decode in the main
process. The legacy `send` path is kept as a fallback when `postMessage` is
unavailable.

```ts
// renderer
logger.addTransport(new ElectronIpcTransport());

// main — with the default Electron runtime this receiver is already registered for
// you; call registerIpcReceiver only when you opt out of, or customize, the runtime.
import { registerIpcReceiver } from 'lograil';
registerIpcReceiver((entry) => logger.ingestEntry(entry));
```

> The `ArrayBuffer` is a transferable. Treat it as moved once sent — do not read
> or reuse it afterwards.
