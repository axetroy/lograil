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
 *
 * A small circuit breaker protects against a dead primary: when the peer is
 * gone, `process.send` fails on every entry and the user-visible console
 * noise would be unbounded. The breaker tracks consecutive failures and,
 * after {@link ClusterIpcTransport.BREAK_AFTER} in a row, stops trying for
 * {@link ClusterIpcTransport.OPEN_MS} milliseconds. Once the channel
 * recovers, the breaker opens again on the next success.
 */
export class ClusterIpcTransport implements Transport {
  readonly name: string;
  /** Optional hook, forwarded to the logger when the breaker opens. */
  onError?: (err: unknown, entry: LogEntry) => void;
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  // Tuned for the cluster IPC case: 5 failures → 5 s open window.
  private static readonly BREAK_AFTER = 5;
  private static readonly OPEN_MS = 5_000;

  constructor(options: ClusterIpcTransportOptions = {}) {
    this.name = options.name ?? 'cluster-ipc';
  }

  write(entry: LogEntry, _formatted: string): void {
    try {
      const proc = process as unknown as {
        send?: (message: unknown, callback?: (err?: Error) => void) => boolean;
      };
      if (typeof proc.send === 'function') {
        // If the circuit is open, skip this entry and surface it via the
        // transport's own `onError` hook so the Logger can report it without
        // spamming the console.
        if (this.breakerOpenUntil > 0 && Date.now() < this.breakerOpenUntil) {
          this.onError?.(
            new Error('cluster-ipc circuit breaker open; entry dropped until next window'),
            entry,
          );
          return;
        }
        proc.send(entry, (err?: Error) => {
          if (err) {
            this.consecutiveFailures += 1;
            if (this.consecutiveFailures >= ClusterIpcTransport.BREAK_AFTER) {
              this.breakerOpenUntil = Date.now() + ClusterIpcTransport.OPEN_MS;
              this.consecutiveFailures = 0;
              this.onError?.(
                new Error(
                  `cluster-ipc: primary unreachable ${ClusterIpcTransport.BREAK_AFTER} times in a row; breaker open for ${ClusterIpcTransport.OPEN_MS}ms`,
                ),
                entry,
              );
            } else {
              RAW_CONSOLE_ERROR('[lograil] cluster-ipc primary unreachable:', err);
            }
          } else {
            this.consecutiveFailures = 0;
            this.breakerOpenUntil = 0;
          }
        });
      }
    } catch {
      /* process.send unavailable — drop silently */
    }
  }

  /** Send a cross-process level command to the primary. */
  sendLevelCommand(level: number): void {
    try {
      const proc = process as unknown as {
        send?: (message: unknown, callback?: (err?: Error) => void) => boolean;
      };
      if (typeof proc.send === 'function') {
        const cmd: LogLevelCommand = { __lograilCmd: true, __lograilCmdType: 'setLevel', level };
        proc.send(cmd, (err?: Error) => {
          if (err) {
            this.consecutiveFailures += 1;
            RAW_CONSOLE_ERROR('[lograil] cluster-ipc level command failed:', err);
          } else {
            this.consecutiveFailures = 0;
            this.breakerOpenUntil = 0;
          }
        });
      }
    } catch {
      /* process.send unavailable — drop silently */
    }
  }

  close(): void {
    /* No-op. Worker lifecycle is managed by the cluster module. */
  }
}

// ---- Primary-side receiver ------------------------------------------------

export interface ClusterReceiverOptions {
  /** Reserved for future use. Currently all cluster messages share one channel. */
  channel?: string;
}

/**
 * Subscriber entry tracked on `globalThis` so that multiple bundled copies of
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
      proc.removeListener?.('message', procState.handler);
      stateMap.delete(_STATE_CLUSTER);
    }
  };
}

/** Reset internal state for testing. */
export function _resetClusterReceiverState(): void {
  const stateMap = _getClusterState();
  stateMap.delete(_STATE_CLUSTER);
}
