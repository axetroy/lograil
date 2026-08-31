import type { LogEntry } from '../types.js';
import type { Transport } from './transport.js';

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
            /* primary gone or channel closed — drop silently */
          }
        });
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
 * Primary-side helper: listen on the cluster IPC channel and feed received
 * worker entries into the provided `ingest` callback (typically
 * `logger.ingestEntry`). Returns an unregister function.
 */
export function registerClusterReceiver(
  ingest: (entry: LogEntry) => void,
  _options: ClusterReceiverOptions = {},
): () => void {
  const proc = process as unknown as {
    on?: (event: string, cb: (...args: unknown[]) => void) => void;
    removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
  };

  if (!proc.on || !proc.removeListener) return () => {};

  const handler = (message: unknown): void => {
    if (
      message &&
      typeof message === 'object' &&
      'level' in message &&
      'message' in message &&
      'timestamp' in message
    ) {
      ingest(message as LogEntry);
    }
  };

  proc.on('message', handler);
  return () => {
    proc.removeListener?.('message', handler);
  };
}
