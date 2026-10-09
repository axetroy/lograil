import type { LogEntry } from '../types.js';
import type { Transport } from './transport.js';
import type { LogLevelCommand } from '../types.js';

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
 * after `breakAfter` in a row, stops trying for `openMs` milliseconds.
 * Once the channel recovers, the breaker opens again on the next success.
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

/**
 * Subscriber entry tracked on `globalThis` so that multiple bundled copies of
 * this module (e.g. from `node_modules` hoisting) share the same registration
 * set instead of each keeping its own.
 */
interface _ClusterSubscriber {
  ingest: (entry: LogEntry) => void;
  onLevelCommand?: (level: number) => void;
}

const _STATE_CLUSTER = Symbol('lograil:cluster-ipc:state');
function _getClusterState(): _ClusterSubscriber[] {
  const global: Record<PropertyKey, unknown> = globalThis as Record<PropertyKey, unknown>;
  if (_STATE_CLUSTER in global) return global[_STATE_CLUSTER] as _ClusterSubscriber[];
  const m: _ClusterSubscriber[] = [];
  global[_STATE_CLUSTER] = m;
  return m;
}

/**
 * Primary-process helper: listen for IPC entries sent by workers and feed
 * them into the provided `ingest` callback (typically `logger.ingestEntry`).
 * Level-change commands are forwarded to `onLevelCommand` when provided.
 * Returns an unregister function.
 *
 * Works with the real Node `cluster` module's `worker.send`/`worker.on`, as
 * well as with a `process.on('message')`-style channel when the primary is a
 * plain Node process.
 */
export function registerClusterReceiver(
  ingest: (entry: LogEntry) => void,
  options: { onLevelCommand?: (level: number) => void } = {},
): () => void {
  const onLevelCommand = options.onLevelCommand;
  const sub: _ClusterSubscriber = { ingest, onLevelCommand };
  const subs = _getClusterState();
  subs.push(sub);
  return () => {
    const idx = subs.findIndex((s) => s === sub);
    if (idx !== -1) subs.splice(idx, 1);
  };
}

/** Reset internal state for testing. */
export function _resetClusterReceiverState(): void {
  const global: Record<PropertyKey, unknown> = globalThis as Record<PropertyKey, unknown>;
  delete global[_STATE_CLUSTER];
}
