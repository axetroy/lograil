import type { RuntimeAdapter } from './adapter.js';
import { createWebRuntime } from './web.js';
import type { NodeRuntimeOptions } from './node.js';
import { createNodeRuntime } from './node.js';
import type { ElectronRuntimeOptions } from './electron.js';
import { createElectronRuntime } from './electron.js';

export type RuntimeOptions = ElectronRuntimeOptions & NodeRuntimeOptions;

/**
 * Auto-detect the current runtime:
 *  - Electron main / renderer when `process.versions.electron` exists;
 *  - Plain Node.js when a Node process is present (has filesystem + pid);
 *  - Web (browser) otherwise.
 *
 * `ElectronRuntimeOptions`/`NodeRuntimeOptions` (e.g. `logFile`) are forwarded
 * to the matching adapter.
 */
export function detectRuntime(options: RuntimeOptions = {}): RuntimeAdapter {
  const versions =
    (typeof process !== 'undefined'
      ? (process as unknown as { versions?: { electron?: string; node?: string } }).versions
      : undefined) ?? {};

  if (versions.electron) {
    return createElectronRuntime(options);
  }
  if (versions.node) {
    return createNodeRuntime(options);
  }
  return createWebRuntime();
}

export type { RuntimeAdapter, RuntimeName, ElectronProcessType, IngestFn } from './adapter.js';
export { createWebRuntime } from './web.js';
export { createNodeRuntime } from './node.js';
export {
  createElectronRuntime,
  createElectronMainRuntime,
  createElectronRendererRuntime,
} from './electron.js';
export type {
  ElectronRuntimeOptions,
  ElectronMainRuntimeOptions,
  ElectronRendererRuntimeOptions,
} from './electron.js';
export {
  ElectronIpcTransport,
  registerIpcReceiver,
  LOGRAIL_CHANNEL,
} from '../transport/electron-ipc.js';
