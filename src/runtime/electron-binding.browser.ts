/**
 * Type of the `electron` module as returned by `require('electron')`. Mirrors
 * the real binding (`Electron.CrossProcessExports`) so the web/browser swap
 * stays type-compatible.
 */
export type ElectronModule = typeof Electron.CrossProcessExports;

// Browser stub: the real `electron` module (and its binary) is never available
// in a web bundle. `package.json`'s `browser` field maps the runtime binding to
// this module so web builds stay free of any `require('electron')`.
export function isElectronProcess(): boolean {
  return false;
}

export function getElectron(): ElectronModule {
  throw new Error('electron is not available in browser builds');
}
