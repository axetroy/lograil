import type { RuntimeAdapter } from './adapter.js';
import type { Transport } from '../transport/transport.js';
import { ConsoleTransport } from '../transport/console.js';
import type { RotateTimeOptions } from '../transport/file.js';
import { FileTransport } from '../transport/file.js';
import { registerIpcReceiver, RENDERER_PROCESS_MARKER } from '../transport/electron-ipc.js';
import { getElectronApp } from './electron-binding.js';
import { createElectronLifecycle } from './electron-lifecycle.js';
import { tmpdir } from '../shims/index.js';
import { join } from '../shims/index.js';

export interface ElectronMainRuntimeOptions {
  /** Forwarded to the main/renderer `FileTransport` (mode `rotate-time`). */
  fileTransportOptions?: Partial<Omit<RotateTimeOptions, 'mode'>>;
  /** Disable the file transport entirely (console only). */
  disableFile?: boolean;
  /**
   * Listen for renderer entries over IPC and write them to the dedicated
   * `renderer.{date}.log` file (default `true`). Main-process entries
   * go to `main.{date}.log`. By default both land under the app's `logs`
   * directory (`app.getPath('logs')`); pass `fileTransportOptions: { dir }`
   * to place them elsewhere.
   */
  receiveFromRenderer?: boolean;
}

/**
 * Log directory for the Electron main runtime. Prefers Electron's dedicated
 * `logs` path (e.g. `<userData>/logs`, already namespaced by the app name so
 * multiple apps never collide), falling back to `<appData>/Logs` and finally
 * the OS temp dir if Electron is unavailable or `app` is not ready.
 */
function defaultElectronLogDir(): string {
  const app = getElectronApp();
  if (app?.getPath) {
    try {
      return app.getPath('logs');
    } catch {
      /* app not ready yet — try the next fallback */
    }
    try {
      return join(app.getPath('appData'), 'Logs');
    } catch {
      /* ignore */
    }
  }
  return tmpdir();
}

/**
 * Electron **main process** runtime. Owns the filesystem, so by default it
 * persists logs to a rotating file (unless `disableFile`) in addition to the
 * console, and (by default) receives renderer entries over IPC so that all
 * logs — including those produced in renderers — are written here.
 */
export function createElectronMainRuntime(
  options: ElectronMainRuntimeOptions = {},
): RuntimeAdapter {
  const pid = typeof process !== 'undefined' ? process.pid : undefined;
  const receiveFromRenderer = options.receiveFromRenderer ?? true;

  const runtime: RuntimeAdapter = {
    name: 'electron',
    processType: 'main',
    now: () => Date.now(),
    pid: () => pid,
    hasFileSystem: () => true,
    defaultTransports: () => {
      const transports: Transport[] = [new ConsoleTransport()];
      if (!options.disableFile) {
        const dir = defaultElectronLogDir();
        transports.push(
          new FileTransport({
            mode: 'rotate-time',
            unit: 'day',
            appName: 'main',
            dir,
            // Main-process entries only: renderer entries are routed to the
            // dedicated renderer log file below.
            filter: (entry) => entry.metadata?.[RENDERER_PROCESS_MARKER] !== 'renderer',
            ...options.fileTransportOptions,
          }),
        );

        if (receiveFromRenderer) {
          transports.push(
            new FileTransport({
              mode: 'rotate-time',
              unit: 'day',
              appName: 'renderer',
              dir,
              // Renderer entries only.
              filter: (entry) => entry.metadata?.[RENDERER_PROCESS_MARKER] === 'renderer',
              ...options.fileTransportOptions,
            }),
          );
        }
      }
      return transports;
    },
    lifecycle: createElectronLifecycle(),
  };

  if (receiveFromRenderer) {
    runtime.attachReceiver = (ingest) => {
      try {
        return registerIpcReceiver(ingest);
      } catch {
        // `electron` not available (e.g. tests) — degrade to a no-op.
        return () => {};
      }
    };
  }

  return runtime;
}
