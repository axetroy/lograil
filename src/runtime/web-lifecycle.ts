import type { LifecycleHooks } from './adapter.js';

/** Minimal structural view of `window` used for unload hooks. */
interface Win {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

function getWindow(): Win | undefined {
  if (typeof window === 'undefined') return undefined;
  return window as unknown as Win;
}

/**
 * Web lifecycle: flush pending entries when the page is being unloaded. There
 * is no `process.exit` and no `uncaughtException` concept in a browser, so this
 * only implements the "flush before close" hook (via `pagehide` /
 * `visibilitychange`) and intentionally omits `onUncaughtError`.
 *
 * The flush is best-effort: the browser terminates the page after the unload
 * event regardless, so the logger's own flush timeout is what bounds how long
 * we wait.
 */
export function createWebLifecycle(): LifecycleHooks {
  return {
    onFlushBeforeExit(cb) {
      const win = getWindow();
      if (!win) return () => {};

      const onHide = (): void => {
        void cb();
      };
      // `pagehide` fires on tab close / navigation. `visibilitychange` covers
      // the backgrounded / mobile case where the page may be discarded.
      win.addEventListener('pagehide', onHide);
      win.addEventListener('visibilitychange', onHide);
      return () => {
        win.removeEventListener('pagehide', onHide);
        win.removeEventListener('visibilitychange', onHide);
      };
    },
  };
}
