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
  // An Electron renderer explicitly reports `process.type === 'renderer'`.
  // The main process may report `'browser'` *or* `undefined`, so anything
  // that is not explicitly a renderer is treated as main.
  return (
    typeof process === 'undefined' || (process as unknown as { type?: string }).type !== 'renderer'
  );
}

/**
 * Auto-detect whether we run in the Electron main or renderer process and
 * return the matching runtime. Prefer the explicit {@link createElectronMainRuntime}
 * / {@link createElectronRendererRuntime} when the process type is known.
 */
export function createElectronRuntime(options: ElectronRuntimeOptions = {}): RuntimeAdapter {
  return isMainProcess()
    ? createElectronMainRuntime(options)
    : createElectronRendererRuntime({
        ipcRenderer:
          typeof require === 'function'
            ? // eslint-disable-next-line @typescript-eslint/no-require-imports
              require('electron').ipcRenderer
            : import('electron').then((e) => e.ipcRenderer),
        ...options,
      });
}
