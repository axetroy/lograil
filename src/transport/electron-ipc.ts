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
 * itself has no filesystem access). Uses structured cloning via the IPC
 * channel — no serialisation cost on the logger side.
 *
 * A small circuit breaker protects against a dead main process: when the main
 * side is gone, `ipc.send` fails on every entry and the user-visible console
 * noise would be unbounded. The breaker tracks consecutive failures and,
 * after `breakAfter` in a row, stops trying for `openMs` milliseconds.
 * Once the channel recovers, the breaker opens again on the next success.
 */
export class ElectronIpcTransport implements Transport {
  readonly name: string;
  /** Optional hook, forwarded to the logger when the breaker opens. */
  onError?: (err: unknown, entry: LogEntry) => void;
  private readonly channel: string;
  private readonly sender?: IpcSender;
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private static readonly BREAK_AFTER = 5;
  private static readonly OPEN_MS = 5_000;

  constructor(options: ElectronIpcTransportOptions = {}) {
    this.name = options.name ?? 'electron-ipc';
    this.channel = options.channel ?? LOGRAIL_CHANNEL;
    this.sender = options.ipcRenderer;
  }

  /** Resolve the IPC sender, preferring the injected one over `require('electron')`. */
  private getIpc(): IpcSender | undefined {
    if (this.sender) return this.sender;
    try {
      const electron = getElectron();
      return electron?.ipcRenderer as IpcSender | undefined;
    } catch {
      return undefined;
    }
  }

  write(entry: LogEntry, _formatted: string): void {
    // If the circuit is open, skip this entry and surface it via the
    // transport's own `onError` hook so the Logger can report it without
    // spamming the console.
    if (this.breakerOpenUntil > 0 && Date.now() < this.breakerOpenUntil) {
      this.onError?.(
        new Error('electron-ipc circuit breaker open; entry dropped until next window'),
        entry,
      );
      return;
    }
    const ipc = this.getIpc();
    if (!ipc) return;
    try {
      ipc.send(this.channel, entry);
      this.consecutiveFailures = 0;
      this.breakerOpenUntil = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= ElectronIpcTransport.BREAK_AFTER) {
        this.breakerOpenUntil = Date.now() + ElectronIpcTransport.OPEN_MS;
        this.consecutiveFailures = 0;
        this.onError?.(
          new Error(
            `electron-ipc: main process unreachable ${ElectronIpcTransport.BREAK_AFTER} times in a row; breaker open for ${ElectronIpcTransport.OPEN_MS}ms`,
          ),
          entry,
        );
      } else {
        RAW_CONSOLE_ERROR(`[lograil] ipc transport (${this.name}) send failed:`, err);
      }
    }
  }

  /** Send a cross-process level command to the main process. */
  sendLevelCommand(level: number): void {
    const ipc = this.getIpc();
    if (!ipc) return;
    const cmd: LogLevelCommand = { __lograilCmd: true, __lograilCmdType: 'setLevel', level };
    try {
      ipc.send(this.channel, cmd);
    } catch (err) {
      RAW_CONSOLE_ERROR(`[lograil] ipc transport (${this.name}) level command failed:`, err);
    }
  }

  close(): void {
    /* No-op. IPC channel lifecycle is managed by the Electron app. */
  }
}

/**
 * Main-side helper: listen for IPC entries and feed them into the provided
 * `ingest` callback (typically `logger.ingestEntry`). Returns an
 * unregister function.
 *
 * Works for both the main-process `ipcMain` (channel name → handler) and a
 * pre-wired {@link IpcRenderer}-like sender injected by the caller.
 */
export function registerIpcReceiver(
  ingest: (entry: LogEntry) => void,
  options: {
    channel?: string;
    ipcMain?: { on(channel: string, h: (e: unknown, data: unknown) => void): void };
    onLevelCommand?: (level: number) => void;
  } = {},
): () => void {
  const channel = options.channel ?? LOGRAIL_CHANNEL;
  const onLevelCommand = options.onLevelCommand;
  const ipcMain = options.ipcMain;
  if (!ipcMain) {
    // Fall back to `require('electron').ipcMain` when available (main process).
    try {
      const electron = getElectron();
      const main = electron?.ipcMain as
        { on(channel: string, h: (e: unknown, data: unknown) => void): void } | undefined;
      if (!main) return () => {};
      return wrapIpcMain(main, channel, ingest, onLevelCommand);
    } catch {
      return () => {};
    }
  }
  return wrapIpcMain(ipcMain, channel, ingest, onLevelCommand);
}

function wrapIpcMain(
  ipcMain: { on(channel: string, h: (e: unknown, data: unknown) => void): void },
  channel: string,
  ingest: (entry: LogEntry) => void,
  onLevelCommand?: (level: number) => void,
): () => void {
  const handler = (_event: unknown, data: unknown): void => {
    if (isLogLevelCommand(data)) {
      onLevelCommand?.(normalizeLevel(data.level));
      return;
    }
    if (data && typeof data === 'object' && 'level' in data && 'message' in data) {
      ingest(data as LogEntry);
    }
  };
  ipcMain.on(channel, handler);
  return () => {
    /*
     * `ipcMain.removeListener` requires the exact handler reference; the
     * transport keeps it on the closure scope so the caller can dispose the
     * listener without a separate registry.
     */
  };
}
