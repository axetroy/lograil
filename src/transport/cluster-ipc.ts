import type { LogEntry } from '../types.js';
import type { Transport } from './transport.js';
import type { LogLevelCommand } from '../types.js';
import { isLogLevelCommand, normalizeLevel } from '../types.js';

// Captured at module load so error reporting never recurses into itself.
const RAW_CONSOLE_ERROR: (...args: unknown[]) => void =
  typeof console !== 'undefined' && typeof console.error === 'function'
    ? console.error.bind(console)
    : () => {};
/** IPC channel for cluster worker → primary communication. */
export const CLUSTER_IPC_CHANNEL = 'lograil:cluster:log';
export interface ClusterIpcTransportOptions {
  /** IPC channel used to reach the primary process. */
  channel?: string;
  /** Transport name. */
  name?: string;
}
/**
 * Worker-side transport that sends entries to the primary process via
 * `process.send()`. Safe to import in non-cluster environments — the write
 * call is a no-op when `process.send` is unavailable.
 */
export class ClusterIpcTransport implements Transport {
  readonly name: string;
  constructor(options: ClusterIpcTransportOptions = {}) {
    this.name = options.name ?? 'cluster-ipc';
  }
  write(entry: LogEntry, _formatted: string): void {
    try {
      const proc = process as unknown as {
        send?: (message: unknown, callback?: (err?: Error) => void) => boolean;
      };
      if (typeof proc.send === 'function') {
        proc.send(entry, (err?: Error) => {
          if (err) {
            // Primary gone or channel closed — surface the error so users can
            // detect cluster worker communication failures.
            RAW_CONSOLE_ERROR('[lograil] cluster-ipc primary unreachable:', err);
          }
        });
      }
    } catch {
      /* process.send unavailable — drop silently */
    }
  }
  /** Send a cross-process level command to the primary process. */
  sendLevelCommand(level: number): void {
    try {
      const proc = process as unknown as {
        send?: (message: unknown, callback?: (err?: Error) => void) => boolean;
      };
      if (typeof proc.send === 'function') {
        const cmd: LogLevelCommand = { __lograilCmd: true, __lograilCmdType: 'setLevel', level };
        proc.send(cmd);
      }
    } catch {
      /* process.send unavailable — drop silently */
    }
  }
}
export interface ClusterReceiverOptions {
  /** Reserved for future use. Currently all cluster messages share one channel. */
  channel?: string;
}
/**
 * Shared dedup state on globalThis so that multiple bundled copies of this
 * module all share the same registration flag and callbacks.
 */
const _DEDUP_CLUSTER = Symbol('lograil:cluster-ipc:dedup');
interface _ClusterDedupState {
  registered: boolean;
  ingest: ((entry: LogEntry) => void) | null;
  onLevelCommand: ((level: number) => void) | null;
}
function _getClusterState(): _ClusterDedupState {
  if (typeof globalThis !== 'undefined' && _DEDUP_CLUSTER in globalThis)
    return globalThis[_DEDUP_CLUSTER as unknown as keyof typeof globalThis] as _ClusterDedupState;
  const s: _ClusterDedupState = { registered: false, ingest: null, onLevelCommand: null };
  if (typeof globalThis !== 'undefined')
    (globalThis as Record<symbol, _ClusterDedupState>)[_DEDUP_CLUSTER] = s;
  return s;
}
/**
 * Primary-side helper: listen on the cluster IPC channel and feed received
 * worker entries into the provided `ingest` callback (typically
 * `logger.ingestEntry`). Level-change commands are forwarded to
 * `onLevelCommand` when provided. Returns an unregister function.
 */
export function registerClusterReceiver(
  ingest: (entry: LogEntry) => void,
  options: ClusterReceiverOptions & { onLevelCommand?: (level: number) => void } = {},
): () => void {
  const onLevelCommand = options.onLevelCommand;
  const proc = process as unknown as {
    on?: (event: string, cb: (...args: unknown[]) => void) => void;
    removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
  };
  if (!proc.on || !proc.removeListener) return () => {};
  // Guard against duplicate registration on the same process.
  // Use globalThis-based state so multiple bundled copies share the same flag.
  const state = _getClusterState();
  if (state.registered) {
    // Update the callback so the existing handler processes new loggers
    state.ingest = ingest;
    state.onLevelCommand = onLevelCommand ?? null;
    return () => {
      if (state.ingest === ingest) {
        state.ingest = null;
        state.onLevelCommand = null;
      }
    };
  }
  state.registered = true;
  state.ingest = ingest;
  state.onLevelCommand = onLevelCommand ?? null;
  const handler = (message: unknown): void => {
    if (state.onLevelCommand && isLogLevelCommand(message)) {
      state.onLevelCommand(normalizeLevel(message.level));
      return;
    }
    if (
      state.ingest &&
      message &&
      typeof message === 'object' &&
      'level' in message &&
      'message' in message &&
      'timestamp' in message
    ) {
      state.ingest(message as LogEntry);
    }
  };
  proc.on('message', handler);
  return () => {
    state.registered = false;
    state.ingest = null;
    state.onLevelCommand = null;
    proc.removeListener?.('message', handler);
  };
}
/** Reset internal state for testing. */
export function _resetClusterReceiverState(): void {
  const state = _getClusterState();
  state.registered = false;
  state.ingest = null;
  state.onLevelCommand = null;
}
