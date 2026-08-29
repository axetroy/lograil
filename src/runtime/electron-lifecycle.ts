import type { LifecycleHooks } from './adapter.js';
import { getElectronApp } from './electron-binding.js';
import { createProcessLifecycle } from './process-lifecycle.js';

/**
 * Electron **main process** lifecycle hooks.
 *
 * GUI-driven termination goes through the Electron `app` event surface
 * (`before-quit` / `will-quit`) rather than Node's `process` events, which do
 * not fire on a normal window close. We flush pending entries on those events,
 * mirroring the existing Node `beforeExit` semantics (fire-and-forget, bounded
 * by the logger's flush timeout). When `app` is unavailable (e.g. a plain Node
 * host, or a test runtime), we fall back to the process-based hooks so the
 * behaviour degrades gracefully.
 *
 * Uncaught-error handling stays on `process` (`uncaughtException` /
 * `unhandledRejection`) — those are still the right surface inside Electron.
 */
export function createElectronLifecycle(): LifecycleHooks {
  const app = getElectronApp();
  const nodeFallback = (): LifecycleHooks => createProcessLifecycle();

  return {
    onFlushBeforeExit(cb) {
      if (!app) return nodeFallback().onFlushBeforeExit(cb);

      // `before-quit` fires first and covers the normal close path; `will-quit`
      // covers the final teardown so a slow first flush still drains.
      const onBeforeQuit = (): void => {
        void cb();
      };
      const onWillQuit = (): void => {
        void cb();
      };
      app.on('before-quit', onBeforeQuit);
      app.on('will-quit', onWillQuit);
      return () => {
        app.removeListener('before-quit', onBeforeQuit);
        app.removeListener('will-quit', onWillQuit);
      };
    },

    onUncaughtError(cb) {
      return nodeFallback().onUncaughtError?.(cb) ?? (() => {});
    },
  };
}
