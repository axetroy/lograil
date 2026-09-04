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
 * Subscriber entry tracked on globalThis so that multiple bundled copies of
 * this module (e.g. from node_modules hoisting or chunk splitting) share the
 * same registration set instead of each keeping their own independent one.
 */
interface _ClusterSubscriber {
  ingest: (entry: LogEntry) => void;
  onLevelCommand?: (level: number) => void;
}
interface _ClusterProcessState {
  subscribers: _ClusterSubscriber[];
  handler: (message: unknown) => void;
}
const _STATE_CLUSTER = Symbol('lograil:cluster-ipc:state');
function _getClusterState(): Map<symbol, _ClusterProcessState> {
  if (typeof globalThis !== 'undefined' && _STATE_CLUSTER in globalThis)
    return globalThis[_STATE_CLUSTER as unknown as keyof typeof globalThis] as Map<
      symbol,
      _ClusterProcessState
    >;
  const m = new Map<symbol, _ClusterProcessState>();
  if (typeof globalThis !== 'undefined')
    (globalThis as Record<symbol, Map<symbol, _ClusterProcessState>>)[_STATE_CLUSTER] = m;
  return m;
}
/**
 * Primary-side helper: listen on the cluster IPC channel and feed received
 * worker entries into the provided `ingest` callback (typically
 * `logger.ingestEntry`). Level-change commands are forwarded to
 * `onLevelCommand` when provided. Returns an unregister function.
 *
 * Multiple loggers can safely register on the same process; each receives its
 * own copy of every message. The 'message' listener is removed only when the
 * last subscriber unregisters.
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
  const stateMap = _getClusterState();
  let procState = stateMap.get(_STATE_CLUSTER);
  if (!procState) {
    // First subscriber for this process — attach a single 'message' handler
    // that fans out to all registered subscribers.
    const subscribers: _ClusterSubscriber[] = [];
    const handler = (message: unknown): void => {
      if (isLogLevelCommand(message)) {
        for (const sub of subscribers) {
          sub.onLevelCommand?.(normalizeLevel(message.level));
        }
        return;
      }
      if (
        message &&
        typeof message === 'object' &&
        'level' in message &&
        'message' in message &&
        'timestamp' in message
      ) {
        const entry = message as LogEntry;
        for (const sub of subscribers) {
          sub.ingest(entry);
        }
      }
    };
    proc.on('message', handler);
    procState = { subscribers, handler };
    stateMap.set(_STATE_CLUSTER, procState);
  }
  procState.subscribers.push({ ingest, onLevelCommand });
  return () => {
    const idx = procState.subscribers.findIndex(
      (s) => s.ingest === ingest && s.onLevelCommand === onLevelCommand,
    );
    if (idx !== -1) procState.subscribers.splice(idx, 1);
    if (procState.subscribers.length === 0) {
      stateMap.delete(_STATE_CLUSTER);
      proc.removeListener?.('message', procState.handler);
    }
  };
}
/** Reset internal state for testing. */
export function _resetClusterReceiverState(): void {
  const stateMap = _getClusterState();
  stateMap.delete(_STATE_CLUSTER);
}
