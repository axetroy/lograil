import type { LogEntry } from '../types.js';
import type { Transport } from './transport.js';
import type { IpcRenderer } from 'electron';
import { getElectron } from '../runtime/electron-binding.js';

/** Minimal view of `IpcRenderer` the transport actually needs. */
type IpcSender = Pick<IpcRenderer, 'send'>;

/** Shape we probe for at runtime to enable the zero-copy transfer path. */
type IpcZeroCopySender = IpcSender & {
  postMessage?: (channel: string, message: unknown, transfer?: unknown[]) => void;
};

// Reused across calls so we don't allocate an encoder/decoder per log line.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Serialize an entry to an `ArrayBuffer` (UTF-8 JSON). The returned buffer is
 * transferable: hand it to `postMessage(channel, buffer, [buffer])` so the
 * underlying memory is moved across the process boundary instead of being
 * structured-cloned (copied) by Electron.
 */
export function encodeEntry(entry: LogEntry): ArrayBuffer {
  return encoder.encode(JSON.stringify(entry)).buffer;
}

/** Inverse of {@link encodeEntry}. */
export function decodeEntry(buffer: ArrayBuffer | Uint8Array): LogEntry {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return JSON.parse(decoder.decode(bytes)) as LogEntry;
}

export const LOGRAIL_CHANNEL = 'lograil:log';

/**
 * Metadata key (on `LogEntry.metadata`) used to mark entries that originated
 * in a renderer process and arrived over IPC. The main runtime uses it to
 * route those entries to a dedicated renderer log file.
 */
export const RENDERER_PROCESS_MARKER = '__lograilProcess';

export interface ElectronIpcTransportOptions {
  /** IPC channel used to reach the main process. */
  channel?: string;
  /** Transport name. */
  name?: string;
  /**
   * Injected IPC sender. Use this when the renderer cannot reach
   * `require('electron')` itself (e.g. `nodeIntegration: false` +
   * `contextIsolation: true`): pass the `ipcRenderer` obtained from a preload
   * bridge instead of letting the transport call `require('electron')`.
   */
  ipcRenderer?: IpcZeroCopySender;
}

/**
 * Renderer-side transport. Forwards each log entry to the Electron main
 * process over IPC, where it is persisted by the main logger (the renderer
 * itself has no filesystem access). The `electron` module is required lazily
 * so this file is safe to import in non-Electron environments.
 */
export class ElectronIpcTransport implements Transport {
  readonly name: string;
  readonly channel: string;

  private injectedIpc?: IpcZeroCopySender;
  private resolvedIpc?: IpcSender;

  constructor(options: ElectronIpcTransportOptions = {}) {
    this.channel = options.channel ?? LOGRAIL_CHANNEL;
    this.name = options.name ?? `ipc:${this.channel}`;
    this.injectedIpc = options.ipcRenderer;
  }

  private getIpc(): IpcSender | undefined {
    if (this.injectedIpc) return this.injectedIpc;
    if (!this.resolvedIpc) {
      try {
        this.resolvedIpc = getElectron().ipcRenderer;
      } catch {
        return undefined;
      }
    }
    return this.resolvedIpc;
  }

  write(entry: LogEntry): void {
    const ipc = this.getIpc();
    if (!ipc) return;
    try {
      const sender = ipc as IpcZeroCopySender;
      if (typeof sender.postMessage === 'function') {
        // Zero-copy path: serialize once, then transfer the buffer's ownership
        // across the process boundary (no structured-clone of the object graph).
        const buf = encodeEntry(entry);
        sender.postMessage(this.channel, buf, [buf]);
      } else {
        // Fallback: Electron structured-clones the whole entry object.
        ipc.send(this.channel, entry);
      }
    } catch {
      /* electron unavailable — drop silently */
    }
  }
}

export interface IpcReceiverOptions {
  channel?: string;
}

/**
 * Main-side helper: listen on the IPC channel and feed received renderer
 * entries into the provided `ingest` callback (typically `logger.ingestEntry`).
 * Returns an unregister function.
 */
export function registerIpcReceiver(
  ingest: (entry: LogEntry) => void,
  options: IpcReceiverOptions = {},
): () => void {
  const channel = options.channel ?? LOGRAIL_CHANNEL;
  // `electron` is only present in a main process; resolve it lazily.
  const ipcMain = getElectron().ipcMain;
  const handler = (_event: unknown, payload: unknown): void => {
    let entry: LogEntry;
    if (payload instanceof ArrayBuffer || payload instanceof Uint8Array) {
      // Zero-copy transfer path: decode the transferred buffer once.
      try {
        entry = decodeEntry(payload);
      } catch {
        return;
      }
    } else {
      entry = payload as LogEntry;
    }
    // Copy-on-write: mark renderer-origin without mutating a shared/frozen entry.
    ingest({
      ...entry,
      metadata: { ...entry.metadata, [RENDERER_PROCESS_MARKER]: 'renderer' },
    });
  };
  ipcMain.on(channel, handler);
  return () => ipcMain.removeListener(channel, handler);
}
