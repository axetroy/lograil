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
 * Subscriber entry tracked on globalThis so that multiple bundled copies of
 * this module (e.g. from node_modules hoisting or chunk splitting) share the
 * same registration set instead of each keeping their own independent one.
 */
interface _ElectronSubscriber {
  ingest: (entry: LogEntry) => void;
  onLevelCommand?: (level: number) => void;
}
interface _ElectronChannelState {
  subscribers: _ElectronSubscriber[];
  handler: (event: unknown, payload: unknown) => void;
}
const _STATE_ELECTRON = Symbol('lograil:electron-ipc:state');
function _getElectronState(): Map<string, _ElectronChannelState> {
  if (typeof globalThis !== 'undefined' && _STATE_ELECTRON in globalThis)
    return globalThis[_STATE_ELECTRON as unknown as keyof typeof globalThis] as Map<
      string,
      _ElectronChannelState
    >;
  const m = new Map<string, _ElectronChannelState>();
  if (typeof globalThis !== 'undefined')
    (globalThis as Record<symbol, Map<string, _ElectronChannelState>>)[_STATE_ELECTRON] = m;
  return m;
}
/**
 * Main-side helper: listen on the IPC channel and feed received renderer
 * entries into the provided `ingest` callback (typically `logger.ingestEntry`).
 * Level-change commands are forwarded to `onLevelCommand` when provided.
 * Multiple loggers can safely register on the same channel; each receives its
 * own copy of every message. The IPC listener is removed only when the last
 * subscriber unregisters.
 */
export function registerIpcReceiver(
  ingest: (entry: LogEntry) => void,
  options: IpcReceiverOptions & { onLevelCommand?: (level: number) => void } = {},
): () => void {
  const channel = options.channel ?? LOGRAIL_CHANNEL;
  const onLevelCommand = options.onLevelCommand;
  // `electron` is only present in a main process; resolve it lazily.
  const ipcMain = getElectron().ipcMain;
  const stateMap = _getElectronState();
  let channelState = stateMap.get(channel);
  if (!channelState) {
    // First subscriber for this channel — attach a single IPC handler that
    // fans out to all registered subscribers.
    const subscribers: _ElectronSubscriber[] = [];
    const handler = (_event: unknown, payload: unknown): void => {
      const data = payload as LogEntry | LogLevelCommand;
      if (isLogLevelCommand(data)) {
        for (const sub of subscribers) {
          sub.onLevelCommand?.(normalizeLevel(data.level));
        }
        return;
      }
      const entry = data as LogEntry;
      for (const sub of subscribers) {
        // Copy-on-write: mark renderer-origin without mutating a shared/frozen entry.
        sub.ingest({
          ...entry,
          metadata: { ...entry.metadata, [RENDERER_PROCESS_MARKER]: 'renderer' },
        });
      }
    };
    ipcMain.on(channel, handler);
    channelState = { subscribers, handler };
    stateMap.set(channel, channelState);
  }
  channelState.subscribers.push({ ingest, onLevelCommand });
  return () => {
    const idx = channelState.subscribers.findIndex(
      (s) => s.ingest === ingest && s.onLevelCommand === onLevelCommand,
    );
    if (idx !== -1) channelState.subscribers.splice(idx, 1);
    if (channelState.subscribers.length === 0) {
      stateMap.delete(channel);
      ipcMain.removeListener(channel, channelState.handler);
    }
  };
}
