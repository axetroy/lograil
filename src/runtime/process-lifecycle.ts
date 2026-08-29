import type { LifecycleHooks } from './adapter.js';

/** Minimal structural view of the Node/Electron `process` used for lifecycle hooks. */
interface Proc {
  on(event: string, cb: (...args: unknown[]) => void): void;
  removeListener(event: string, cb: (...args: unknown[]) => void): void;
  exit(code: number): void;
}

function getProcess(): Proc | undefined {
  if (typeof process === 'undefined' || typeof (process as { on?: unknown }).on !== 'function') {
    return undefined;
  }
  return process as unknown as Proc;
}

/**
 * Lifecycle hooks backed by the Node/Electron `process` event surface. Shared
 * by the Node runtime and both Electron process types — they all expose the
 * same `process` events.
 *
 * The flush callback is supplied by the logger; this module only decides
 * *when* to call it and owns the `process.exit()` that follows a signal or a
 * fatal, uncaught crash. It never touches `window`, so it is safe to import in
 * any runtime (the `process` probe just returns `undefined` where absent).
 */
export function createProcessLifecycle(): LifecycleHooks {
  return {
    onFlushBeforeExit(cb) {
      const proc = getProcess();
      if (!proc) return () => {};

      // Normal event-loop drain: flush pending writes; the process exits on
      // its own once the loop empties. `beforeExit` re-fires while async writes
      // keep it alive, so the queue keeps draining until empty.
      const onBeforeExit = (): void => {
        void cb();
      };
      // A signal must force an exit after flushing — but never hang shutdown on
      // a stalled transport (the logger's flush timeout bounds it).
      const onSignal = (code: number): void => {
        void Promise.resolve(cb()).finally(() => {
          try {
            proc.exit(code);
          } catch {
            /* ignore */
          }
        });
      };
      const onSigInt = (): void => onSignal(130);
      const onSigTerm = (): void => onSignal(143);

      proc.on('beforeExit', onBeforeExit);
      proc.on('SIGINT', onSigInt);
      proc.on('SIGTERM', onSigTerm);
      return () => {
        proc.removeListener('beforeExit', onBeforeExit);
        proc.removeListener('SIGINT', onSigInt);
        proc.removeListener('SIGTERM', onSigTerm);
      };
    },

    onUncaughtError(cb) {
      const proc = getProcess();
      if (!proc) return () => {};

      // Log the crash at fatal level, flush, then exit(1) — but never hang on a
      // stalled transport (the logger's flush timeout bounds the flush).
      const onErr = (err: unknown): void => {
        void Promise.resolve(cb(err)).finally(() => {
          try {
            proc.exit(1);
          } catch {
            /* ignore */
          }
        });
      };
      proc.on('uncaughtException', onErr);
      proc.on('unhandledRejection', onErr);
      return () => {
        proc.removeListener('uncaughtException', onErr);
        proc.removeListener('unhandledRejection', onErr);
      };
    },
  };
}
