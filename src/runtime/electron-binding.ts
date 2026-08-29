import type { App } from 'electron';

/**
 * Type of the `electron` module as returned by `require('electron')`. We use
 * electron's own `Electron.CrossProcessExports` type so we stay in sync with
 * the real API without hand-writing interfaces.
 */
export type ElectronModule = typeof Electron.CrossProcessExports;

let cached: ElectronModule | null | undefined;

/** True when running inside an Electron process. */
export function isElectronProcess(): boolean {
  return (
    typeof process !== 'undefined' &&
    !!(process as { versions?: { electron?: string } }).versions?.electron
  );
}

/**
 * Resolve the `electron` module. This is the **only** place in the library
 * that performs `require('electron')`, so a web bundler can swap this whole
 * module for `electron-binding.browser` (via package.json `browser`) and never
 * touch the Electron binary.
 */
export function getElectron(): ElectronModule {
  if (cached !== undefined) {
    if (cached === null) {
      throw new Error('electron is only available inside an Electron process');
    }
    return cached;
  }
  if (!isElectronProcess()) {
    cached = null;
    throw new Error('electron is only available inside an Electron process');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  cached = require('electron') as ElectronModule;
  return cached;
}

/**
 * Resolve the Electron `app` instance. Only meaningful inside a real Electron
 * process; returns `undefined` when Electron is absent or `app` can't be read
 * (e.g. a renderer process, or a bundler that stripped `electron`). This is the
 * runtime layer's single entry point for `app`-level lifecycle wiring.
 */
export function getElectronApp(): App | undefined {
  if (!isElectronProcess()) return undefined;
  try {
    return getElectron().app;
  } catch {
    return undefined;
  }
}
