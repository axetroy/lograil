import type { LogEntry } from '../types.js';
import type { Transport } from './transport.js';
import type { LogLevelCommand } from '../types.js';
import { isLogLevelCommand, normalizeLevel } from '../types.js';
import type { IpcRenderer } from 'electron';
import { getElectron } from '../runtime/electron-binding.js';

// Captured at module load so error reporting never recurses into itself.
const RAW_CONSOLE_ERROR: (...args: unknown[]) => void =
  typeof console !== 'undefined' && typeof console.error === 'function'
    ? console.error.bind(console)
    : () => {};

/** Minimal view of "IpcRenderer" the transport actually needs. */
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
 * itself has no filesystem access). Uses structured cloning via
 * `ipcRenderer.send()`.
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

  write(entry: LogEntry, _formatted: string): void {
    const ipc = this.getIpc();
    if (!ipc) return;
    try {
      ipc.send(this.channel, entry);
    } catch (err) {
      // Report IPC failure so users can diagnose renderer -> main delivery issues.
      RAW_CONSOLE_ERROR(`[lograil] ipc transport (${this.name}) send failed:`, err);
    }
  }

  /** Send a cross-process level command to the main process. */
  sendLevelCommand(level: number): void {
    const ipc = this.getIpc();
    if (!ipc) return;
    const cmd: LogLevelCommand = { __lograilCmd: true, __lograilCmdType: 'setLevel', level };
    try {
      ipc.send(this.channel, cmd);
    } catch {
      /* silently drop - command loss is not fatal */
    }
  }
}

export interface IpcReceiverOptions {
  channel?: string;
}

/**
 * Main-side helper: listen on the IPC channel and feed received renderer
 * entries into the provided `ingest` callback (typically `logger.ingestEntry`).
 * Level-change commands are forwarded to `onLevelCommand` when provided.
 * Returns an unregister function.
 */
export function registerIpcReceiver(
  ingest: (entry: LogEntry) => void,
  options: IpcReceiverOptions & { onLevelCommand?: (level: number) => void } = {},
): () => void {
  const channel = options.channel ?? LOGRAIL_CHANNEL;
  const onLevelCommand = options.onLevelCommand;
  // `electron` is only present in a main process; resolve it lazily.
  const ipcMain = getElectron().ipcMain;
  const handler = (_event: unknown, payload: unknown): void => {
    const data = payload as LogEntry | LogLevelCommand;
    if (isLogLevelCommand(data)) {
      onLevelCommand?.(normalizeLevel(data.level));
      return;
    }
    const entry = data as LogEntry;
    // Copy-on-write: mark renderer-origin without mutating a shared/frozen entry.
    ingest({
      ...entry,
      metadata: { ...entry.metadata, [RENDERER_PROCESS_MARKER]: 'renderer' },
    });
  };
  ipcMain.on(channel, handler);
  return () => ipcMain.removeListener(channel, handler);
}
