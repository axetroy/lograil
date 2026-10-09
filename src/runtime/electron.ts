import type { RuntimeAdapter } from './adapter.js';
import { createElectronMainRuntime } from './electron-main.js';
import type { ElectronMainRuntimeOptions } from './electron-main.js';
import { createElectronRendererRuntime } from './electron-renderer.js';
import type { ElectronRendererRuntimeOptions } from './electron-renderer.js';

export { createElectronMainRuntime } from './electron-main.js';
export type { ElectronMainRuntimeOptions } from './electron-main.js';
export { createElectronRendererRuntime } from './electron-renderer.js';
export type { ElectronRendererRuntimeOptions } from './electron-renderer.js';

/**
 * Options accepted by {@link createElectronRuntime}. This is the union of the
 * main and renderer runtime options; only the relevant subset is used after
 * the process type is detected.
 */
export type ElectronRuntimeOptions = ElectronMainRuntimeOptions & ElectronRendererRuntimeOptions;

function isMainProcess(): boolean {
  // Only a genuine Electron main process can be trusted here: it has both
  // `process.versions.electron` and a `process.type` of 'browser' (or absent,
  // in some sandboxed configurations). A renderer reports 'renderer'.
  //
  // Critically, if `process` is missing entirely we are NOT in Electron at
  // all (e.g. a plain web page or a bundle that stripped `process`); routing
  // that to the main runtime would attempt filesystem / IPC work that is
  // unavailable. Treat the absence of `process` as "not main" so the caller
  // can fall back to a console-only renderer-style runtime.
  if (typeof process === 'undefined') return false;
  const proc = process as unknown as { type?: string; versions?: { electron?: string } };
  // `process.versions.electron` is the authoritative "we are in Electron"
  // signal; without it we cannot be an Electron main process.
  if (!proc.versions?.electron) return false;
  // In Electron the main process reports 'browser'; a renderer reports
  // 'renderer'. An absent `type` (some sandboxed builds) is treated as main
  // because `process.versions.electron` already confirmed the runtime.
  return proc.type !== 'renderer';
}

/**
 * Auto-detect whether we run in the Electron main or renderer process and
 * return the matching runtime. Prefer the explicit {@link createElectronMainRuntime}
 * / {@link createElectronRendererRuntime} when the process type is known.
 */
export function createElectronRuntime(options: ElectronRuntimeOptions = {}): RuntimeAdapter {
  // `options` is spread AFTER `ipcRenderer` so an injected `ipcRenderer`
  // always wins; only the require-based fallback (computed below) is the
  // default when the caller has not provided one.
  return isMainProcess()
    ? createElectronMainRuntime(options)
    : createElectronRendererRuntime({
        // Only attempt the `require('electron')` IPC fallback when the caller
        // has not injected an `ipcRenderer`. The require is wrapped in a
        // try/catch so a missing Electron install (or a bundler that stripped
        // it) degrades gracefully to `undefined` instead of throwing at
        // auto-detection time.
        ipcRenderer: safeRequireIpcRenderer(),
        ...options,
      });
}

/** Best-effort `require('electron').ipcRenderer`; returns `undefined` when unavailable. */
function safeRequireIpcRenderer():
  { send: (channel: string, ...args: unknown[]) => void } | undefined {
  if (typeof require !== 'function') return undefined;
  try {
    const electronModule: {
      ipcRenderer?: { send: (channel: string, ...args: unknown[]) => void };
    } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      require('electron');
    return electronModule?.ipcRenderer;
  } catch {
    return undefined;
  }
}
