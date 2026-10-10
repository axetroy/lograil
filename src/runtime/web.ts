import { ConsoleTransport } from '../transport/console.js';
import { WorkerIpcTransport, registerWorkerReceiver } from '../transport/worker-ipc.js';
import type { RuntimeAdapter } from './adapter.js';
import { createWebLifecycle } from './web-lifecycle.js';

declare const WorkerGlobalScope: unknown;

/**
 * Detect whether the current context is a Web Worker, dedicated worker, or
 * Node worker_threads. Uses `typeof` checks that are safe in all
 * environments (returns false in non-worker contexts).
 *
 * Covers:
 *  - Web dedicated/`Worker` (WorkerGlobalScope, no `document`)
 *  - Shared workers (`self instanceof SharedWorkerGlobalScope`)
 *  - Deno / Bun worker threads (`DedicatedWorkerGlobalScope`, or
 *    `self !== globalThis` as a cross-runtime heuristic)
 *  - Node `worker_threads` (`parentPort.postMessage` available)
 */
function isWorkerThread(): boolean {
  const g = globalThis as Record<string, unknown>;

  // Web dedicated worker (or any WorkerGlobalScope without `document`).
  if (
    typeof WorkerGlobalScope !== 'undefined' &&
    typeof self !== 'undefined' &&
    typeof (self as { document?: unknown }).document === 'undefined'
  ) {
    return true;
  }

  // SharedWorker scope (dedicated workers above may already have matched;
  // shared workers have `postMessage`/`onmessage` but no `document`).
  if (typeof g.SharedWorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
    return true;
  }

  // Deno / Bun / edge worker runtimes: `self` may be a DedicatedWorkerGlobalScope
  // that is not the same object as `globalThis`, or the runtime may not
  // expose `WorkerGlobalScope` at all.
  if (
    typeof g.DedicatedWorkerGlobalScope !== 'undefined' &&
    typeof self !== 'undefined' &&
    typeof (self as { document?: unknown }).document === 'undefined'
  ) {
    return true;
  }

  // Node worker_threads: `parentPort` with a `postMessage` function is the
  // authoritative signal.
  if (
    typeof g.parentPort !== 'undefined' &&
    typeof (g.parentPort as { postMessage?: unknown }).postMessage === 'function'
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
    attachReceiver: (ingest, onLevelCommand) => registerWorkerReceiver(ingest, { onLevelCommand }),
    lifecycle: createWebLifecycle(),
  };
}
