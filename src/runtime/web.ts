import { ConsoleTransport } from '../transport/console.js';
import { WorkerIpcTransport, registerWorkerReceiver } from '../transport/worker-ipc.js';
import type { RuntimeAdapter } from './adapter.js';
import { createWebLifecycle } from './web-lifecycle.js';

declare const WorkerGlobalScope: unknown;

/**
 * Detect whether the current context is a Web Worker or Node worker_threads.
 * Uses `typeof` checks that are safe in all environments (returns false in
 * non-worker contexts).
 */
function isWorkerThread(): boolean {
  // Web Worker: WorkerGlobalScope exists and there's no document (rules out window)
  if (
    typeof WorkerGlobalScope !== 'undefined' &&
    typeof self !== 'undefined' &&
    typeof (self as { document?: unknown }).document === 'undefined'
  ) {
    return true;
  }
  // Node worker_threads: parentPort exists with postMessage
  if (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { parentPort?: { postMessage: unknown } }).parentPort?.postMessage ===
      'function'
  ) {
    return true;
  }
  return false;
}

/**
 * Web runtime (browsers + Node worker_threads). No process id, no filesystem,
 * console only by default. Remote HTTP transports can be added by the
 * application.
 *
 * **Worker support.** When running inside a Web Worker or Node worker_threads
 * worker, the runtime automatically detects the Worker context and sends
 * entries to the main/parent thread via `postMessage()`. The parent thread
 * receives them via `registerWorkerReceiver()` (attached automatically by
 * `createWebRuntime()`).
 */
export function createWebRuntime(): RuntimeAdapter {
  if (isWorkerThread()) {
    // ── Worker: no file, send to parent via postMessage ──
    return {
      name: 'web',
      now: () => Date.now(),
      pid: () => undefined,
      hasFileSystem: () => false,
      defaultTransports: () => [new ConsoleTransport(), new WorkerIpcTransport()],
      lifecycle: createWebLifecycle(),
    };
  }

  // ── Main/parent thread: console only + receives worker logs ──
  return {
    name: 'web',
    now: () => Date.now(),
    pid: () => undefined,
    hasFileSystem: () => false,
    defaultTransports: () => [new ConsoleTransport()],
    attachReceiver: (ingest) => registerWorkerReceiver(ingest),
    lifecycle: createWebLifecycle(),
  };
}
