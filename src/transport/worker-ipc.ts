import type { LogEntry } from '../types.js';
import type { Transport } from './transport.js';

/** Minimal view of the `postMessage` function available in Web Workers and Node worker_threads. */
type PostMessageFn = (message: unknown, transfer?: unknown[]) => void;

/** Minimal view of a Worker-like target that can receive messages. */
type MessageTarget = {
  postMessage: PostMessageFn;
};

export interface WorkerIpcTransportOptions {
  /** Transport name. */
  name?: string;
}

/**
 * Worker-side transport that sends entries to the main thread via
 * `self.postMessage()`. Safe to import in non-Worker environments — the write
 * call is a no-op when `self.postMessage` is unavailable.
 */
export class WorkerIpcTransport implements Transport {
  readonly name: string;

  constructor(options: WorkerIpcTransportOptions = {}) {
    this.name = options.name ?? 'worker-ipc';
  }

  write(entry: LogEntry, _formatted: string): void {
    try {
      const target = self as unknown as MessageTarget;
      if (typeof target.postMessage === 'function') {
        target.postMessage({ __lograilWorker: true, entry });
      }
    } catch {
      /* postMessage unavailable or failed — drop silently */
    }
  }
}

export interface WorkerReceiverOptions {
  /** Specific Worker instance to listen on. If omitted, listens on `self.onmessage` (shared worker / global). */
  worker?: MessageTarget;
}

/**
 * Main-thread helper: listen for worker entries and feed them into the
 * provided `ingest` callback (typically `logger.ingestEntry`). Returns an
 * unregister function.
 *
 * Works with `Worker` instances (dedicated workers). For a specific worker
 * pass `worker: myWorkerInstance`; otherwise listens on `self.onmessage`
 * for shared-worker / broadcast-channel patterns.
 */
export function registerWorkerReceiver(
  ingest: (entry: LogEntry) => void,
  options: WorkerReceiverOptions = {},
): () => void {
  const handler = (event: MessageEvent): void => {
    const data = event.data;
    if (
      data &&
      typeof data === 'object' &&
      '__lograilWorker' in data &&
      data.__lograilWorker === true &&
      'entry' in data
    ) {
      ingest(data.entry as LogEntry);
    }
  };

  const worker = options.worker as unknown as
    | { onmessage: ((e: MessageEvent) => void) | null; on?: never }
    | { on?: (event: string, handler: (data: unknown) => void) => void; onmessage?: never }
    | undefined;

  if (worker && typeof worker === 'object') {
    if ('on' in worker && typeof worker.on === 'function') {
      // Node Worker instance — worker.on('message', handler)
      // Node passes raw data (not MessageEvent), so adapt:
      const nodeHandler = (data: unknown): void => {
        if (
          data &&
          typeof data === 'object' &&
          '__lograilWorker' in data &&
          (data as Record<string, unknown>).__lograilWorker === true &&
          'entry' in data
        ) {
          ingest((data as { entry: LogEntry }).entry);
        }
      };
      worker.on('message', nodeHandler);
      return () => {
        /* Node Worker doesn't support off(); callers should dispose the Worker */
      };
    }

    if ('onmessage' in worker) {
      // Web Worker — dedicated worker onmessage
      worker.onmessage = handler;
      return () => {
        if (worker.onmessage === handler) worker.onmessage = null;
      };
    }
  }

  // Global self.onmessage — shared worker / fallback
  const prev = self.onmessage;
  self.addEventListener('message', handler as EventListener);
  return () => {
    self.removeEventListener('message', handler as EventListener);
    // Restore previous handler if it was there
    if (self.onmessage === null && prev !== undefined) {
      self.onmessage = prev;
    }
  };
}
