# Immutability & zero-copy

`lograil` is built for speed. The core idea is simple: **we never copy your log
data as it flows through the pipeline** — within one process every transport shares
the same object, and across processes we pack it only once.

## A log entry becomes read-only once it reaches a transport

A log entry (`LogEntry`) can only be changed while it is being built and while
plugins run. The moment it is about to be written by the transports, we call
`freezeEntry` to **freeze** it (i.e. make it read-only):

- the entry object itself can no longer be changed;
- its `context`, `metadata` and `args` fields can no longer be changed;
- however, deeply nested values are *not* locked down (a full deep-freeze would
  re-introduce a copy for every log line, which would hurt performance).

After freezing, every transport, formatter and plugin reads the **same** object.
Because it is read-only, no transport can accidentally corrupt the entry another
transport is using, and you can pass it around by reference (without copying) safely.

```ts
import { createLogger, freezeEntry } from 'lograil';

const logger = createLogger({ transports: [/* … */] });
// Entries are frozen for you automatically just before transports run — you
// normally never call freezeEntry yourself.
```

If you build entries yourself (for example feeding them via `ingestEntry`), freeze
them too, to get the same "can't be corrupted" guarantee:

```ts
const frozen = freezeEntry(entry);
logger.ingestEntry(frozen);
```

Plugins and processors follow a **"copy before mutating"** rule: they never edit
the original entry in place; instead they copy it first and return the copy
(`{ ...entry, … }`). This keeps the original read-only while letting the next stage
share the same data by reference.

## Zero-copy across processes (Electron renderer → main)

`ElectronIpcTransport` forwards renderer logs to the main process. Electron's
`ipcRenderer.send(channel, entry)` makes a **full copy of the whole entry object**
every time it sends (technically a "structured clone"). When `context` is large,
that copy is expensive.

To avoid copying over and over, when `postMessage` is available the transport:

1. packs the entry once into a UTF-8 binary buffer (`encodeEntry`), then
2. hands the buffer's **ownership** to the main process via
   `postMessage(channel, buffer, [buffer])` (this is called a *transfer*).

A *transfer* means "give the memory to the other side" rather than "copy it for the
other side". So the only extra work on the hot path is a single encode on the
renderer and a single decode on the main process. When `postMessage` is unavailable,
it falls back to the old `send` behavior.

```ts
// renderer
logger.addTransport(new ElectronIpcTransport());

// main — with the default Electron runtime this receiver is already registered for
// you; call registerIpcReceiver only when you opt out of, or customize, the runtime.
import { registerIpcReceiver } from 'lograil';
registerIpcReceiver((entry) => logger.ingestEntry(entry));
```

> That binary buffer (`ArrayBuffer`) is owned by the receiver once *transferred* —
> after sending, do not read or reuse it.
