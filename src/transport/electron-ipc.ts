import type { LogEntry } from '../types.js';
import type { Transport } from './transport.js';
import type { IpcRenderer } from 'electron';
import { getElectron } from '../runtime/electron-binding.js';

/** Minimal view of `IpcRenderer` the transport actually needs. */
type IpcSender = Pick<IpcRenderer, 'send'>;

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
  ipcRenderer?: IpcSender;
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

  private injectedIpc?: IpcSender;
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
    try {
      this.getIpc()?.send(this.channel, entry);
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
  const handler = (_event: unknown, entry: LogEntry): void => {
    // Mark renderer-originated entries so the main runtime can route them to
    // a dedicated renderer log file instead of mixing them into main's log.
    if (entry && entry.metadata) {
      entry.metadata[RENDERER_PROCESS_MARKER] = 'renderer';
    }
    ingest(entry);
  };
  ipcMain.on(channel, handler);
  return () => ipcMain.removeListener(channel, handler);
}
