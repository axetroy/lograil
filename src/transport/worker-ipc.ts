import type { LogEntry } from '../types.js';
import type { Transport } from './transport.js';
import type { LogLevelCommand } from '../types.js';
import { isLogLevelCommand } from '../types.js';
import { normalizeLevel } from '../types.js';
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
  /** Send a cross-process level command to the main thread. */
  sendLevelCommand(level: number): void {
    try {
      const target = self as unknown as MessageTarget;
      if (typeof target.postMessage === 'function') {
        const cmd: LogLevelCommand = { __lograilCmd: true, __lograilCmdType: 'setLevel', level };
        target.postMessage(cmd);
      }
    } catch {
      /* postMessage unavailable — drop silently */
    }
  }
  close(): void {
    /* No-op. Worker lifecycle is managed by the Worker instance itself. */
  }
}
export interface WorkerReceiverOptions {
  /** Specific Worker instance to listen on. If omitted, listens on `self.onmessage` (shared worker / global). */
  worker?: MessageTarget;
}
/**
 * Shared dedup state on globalThis so that multiple bundled copies of this
 * module all share the same registration flag and callbacks.
 */
const _DEDUP_WORKER = Symbol('lograil:worker-ipc:dedup');
interface _WorkerDedupState {
  registered: boolean;
  ingest: ((entry: LogEntry) => void) | null;
  onLevelCommand: ((level: number) => void) | null;
}
function _getWorkerState(): _WorkerDedupState {
  if (typeof globalThis !== 'undefined' && _DEDUP_WORKER in globalThis)
    return globalThis[_DEDUP_WORKER as unknown as keyof typeof globalThis] as _WorkerDedupState;
  const s: _WorkerDedupState = { registered: false, ingest: null, onLevelCommand: null };
  if (typeof globalThis !== 'undefined')
    (globalThis as Record<symbol, _WorkerDedupState>)[_DEDUP_WORKER] = s;
  return s;
}
/**
 * Main-thread helper: listen for worker entries and feed them into the
 * provided `ingest` callback (typically `logger.ingestEntry`). Level-change
 * commands are forwarded to `onLevelCommand` when provided.
 * Returns an unregister function.
 *
 * Works with `Worker` instances (dedicated workers). For a specific worker
 * pass `worker: myWorkerInstance`; otherwise listens on `self.onmessage`
 * for shared-worker / broadcast-channel patterns.
 */
export function registerWorkerReceiver(
  ingest: (entry: LogEntry) => void,
  options: WorkerReceiverOptions & { onLevelCommand?: (level: number) => void } = {},
): () => void {
  const onLevelCommand = options.onLevelCommand;
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
    } else if (isLogLevelCommand(data)) {
      onLevelCommand?.(normalizeLevel(data.level));
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
        if (isLogLevelCommand(data)) {
          onLevelCommand?.(normalizeLevel(data.level));
          return;
        }
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
      // Web Worker — dedicated worker onmessage (single handler, no dedup needed)
      worker.onmessage = handler;
      return () => {
        if (worker.onmessage === handler) worker.onmessage = null;
      };
    }
  }
  // Global self.onmessage — shared worker / fallback
  // Guard against duplicate registration on the global scope.
  // Use globalThis-based state so multiple bundled copies share the same flag.
  const state = _getWorkerState();
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
  const globalHandler = (event: MessageEvent): void => {
    const data = event.data;
    if (
      data &&
      typeof data === 'object' &&
      '__lograilWorker' in data &&
      data.__lograilWorker === true &&
      'entry' in data
    ) {
      if (state.ingest) {
        state.ingest(data.entry as LogEntry);
      }
    } else if (isLogLevelCommand(data) && state.onLevelCommand) {
      state.onLevelCommand(normalizeLevel(data.level));
    }
  };
  // Safe access to self — only in environments where self exists
  const targetSelf = typeof self !== 'undefined' ? self : null;
  if (targetSelf) {
    const prevOnMessage = targetSelf.onmessage;
    targetSelf.addEventListener('message', globalHandler as EventListener);
    return () => {
      state.registered = false;
      state.ingest = null;
      state.onLevelCommand = null;
      targetSelf.removeEventListener('message', globalHandler as EventListener);
      if (targetSelf.onmessage === globalHandler || targetSelf.onmessage === prevOnMessage) {
        targetSelf.onmessage = prevOnMessage;
      }
    };
  }
  // Fallback for Node environments without self — no-op
  return () => {};
}
/** Reset internal state for testing. */
export function _resetWorkerReceiverState(): void {
  const state = _getWorkerState();
  state.registered = false;
  state.ingest = null;
  state.onLevelCommand = null;
}
