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
 *
 * A small circuit breaker protects against a dead main thread: when the peer
 * is gone, every `postMessage` throws and the user-visible noise would be
 * unbounded. The breaker tracks consecutive failures and, after
 * {@link WorkerIpcTransport.BREAK_AFTER} in a row, suppresses per-entry
 * error reporting for {@link WorkerIpcTransport.OPEN_MS} milliseconds.
 * Delivery is still attempted on every write (so the channel recovers as
 * soon as the peer returns); a single "breaker open" diagnostic is emitted
 * when the breaker trips, and the window is extended while failures
 * continue.
 */
export class WorkerIpcTransport implements Transport {
  readonly name: string;
  /** Optional hook, forwarded to the logger when the breaker opens. */
  onError?: (err: unknown, entry: LogEntry) => void;
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private static readonly BREAK_AFTER = 5;
  private static readonly OPEN_MS = 5_000;

  constructor(options: WorkerIpcTransportOptions = {}) {
    this.name = options.name ?? 'worker-ipc';
  }

  write(entry: LogEntry, _formatted: string): void {
    try {
      // While the breaker is open we still attempt delivery on every write
      // (so the channel can recover as soon as the peer comes back), but we
      // suppress the per-entry error reporting that would otherwise spam the
      // console. A single "breaker open" diagnostic is emitted when the
      // breaker trips; individual failures inside the open window are silent.
      const breakerOpen = this.breakerOpenUntil > 0 && Date.now() < this.breakerOpenUntil;
      const target = self as unknown as MessageTarget;
      if (typeof target.postMessage === 'function') {
        try {
          target.postMessage({ __lograilWorker: true, entry });
          this.consecutiveFailures = 0;
          this.breakerOpenUntil = 0;
        } catch {
          if (breakerOpen) {
            // Still failing while the breaker is open — extend the window so
            // a permanently-dead peer does not produce unbounded noise.
            this.breakerOpenUntil = Date.now() + WorkerIpcTransport.OPEN_MS;
            return;
          }
          this.consecutiveFailures += 1;
          if (this.consecutiveFailures >= WorkerIpcTransport.BREAK_AFTER) {
            this.breakerOpenUntil = Date.now() + WorkerIpcTransport.OPEN_MS;
            this.consecutiveFailures = 0;
            this.onError?.(
              new Error(
                `worker-ipc: main thread unreachable ${WorkerIpcTransport.BREAK_AFTER} times in a row; breaker open for ${WorkerIpcTransport.OPEN_MS}ms`,
              ),
              entry,
            );
          }
        }
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
        this.consecutiveFailures = 0;
        this.breakerOpenUntil = 0;
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
 * Subscriber entry tracked on globalThis so that multiple bundled copies of
 * this module (e.g. from node_modules hoisting or chunk splitting) share the
 * same registration set instead of each keeping their own independent one.
 */
interface _WorkerSubscriber {
  ingest: (entry: LogEntry) => void;
  onLevelCommand?: (level: number) => void;
}
interface _WorkerGlobalState {
  subscribers: _WorkerSubscriber[];
  handler: (event: MessageEvent) => void;
}
const _STATE_WORKER = Symbol('lograil:worker-ipc:state');
function _getWorkerState(): Map<symbol, _WorkerGlobalState> {
  if (typeof globalThis !== 'undefined' && _STATE_WORKER in globalThis)
    return globalThis[_STATE_WORKER as unknown as keyof typeof globalThis] as Map<
      symbol,
      _WorkerGlobalState
    >;
  const m = new Map<symbol, _WorkerGlobalState>();
  if (typeof globalThis !== 'undefined')
    (globalThis as Record<symbol, Map<symbol, _WorkerGlobalState>>)[_STATE_WORKER] = m;
  return m;
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
  const stateMap = _getWorkerState();
  let globalState = stateMap.get(_STATE_WORKER);
  if (!globalState) {
    // First subscriber — attach a single handler that fans out to all subscribers.
    const subscribers: _WorkerSubscriber[] = [];
    const globalHandler = (event: MessageEvent): void => {
      const data = event.data;
      if (
        data &&
        typeof data === 'object' &&
        '__lograilWorker' in data &&
        data.__lograilWorker === true &&
        'entry' in data
      ) {
        for (const sub of subscribers) {
          sub.ingest(data.entry as LogEntry);
        }
      } else if (isLogLevelCommand(data)) {
        for (const sub of subscribers) {
          sub.onLevelCommand?.(normalizeLevel(data.level));
        }
      }
    };
    const targetSelf = typeof self !== 'undefined' ? self : null;
    if (targetSelf) {
      targetSelf.addEventListener('message', globalHandler as EventListener);
      globalState = { subscribers, handler: globalHandler };
      stateMap.set(_STATE_WORKER, globalState);
    }
  }
  if (!globalState) {
    // No `self` available in this environment — no-op
    return () => {};
  }
  globalState.subscribers.push({ ingest, onLevelCommand });
  return () => {
    const idx = globalState.subscribers.findIndex(
      (s) => s.ingest === ingest && s.onLevelCommand === onLevelCommand,
    );
    if (idx !== -1) globalState.subscribers.splice(idx, 1);
    if (globalState.subscribers.length === 0) {
      const targetSelf = typeof self !== 'undefined' ? self : null;
      if (targetSelf) {
        targetSelf.removeEventListener('message', globalState.handler as EventListener);
        // Restore previous onmessage if it was set by something else
        if (targetSelf.onmessage === globalState.handler) {
          targetSelf.onmessage = null;
        }
      }
      stateMap.delete(_STATE_WORKER);
    }
  };
}
/** Reset internal state for testing. */
export function _resetWorkerReceiverState(): void {
  const stateMap = _getWorkerState();
  stateMap.delete(_STATE_WORKER);
}
