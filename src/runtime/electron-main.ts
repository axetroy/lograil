import type { RuntimeAdapter } from './adapter.js';
import type { Transport } from '../transport/transport.js';
import { ConsoleTransport } from '../transport/console.js';
import type { RotatingFileTransportOptions } from '../transport/rotating-file.js';
import { RotatingFileTransport } from '../transport/rotating-file.js';
import { registerIpcReceiver, RENDERER_PROCESS_MARKER } from '../transport/electron-ipc.js';
import { getElectron, isElectronProcess } from './electron-binding.js';
import type { App } from 'electron';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ElectronMainRuntimeOptions {
  fileTransportOptions?: Partial<RotatingFileTransportOptions>;
  /** Disable the file transport entirely (console only). */
  disableFile?: boolean;
  /**
   * Listen for renderer entries over IPC and write them to the dedicated
   * `renderer.{date}.{index}.log` file (default `true`). Main-process entries
   * go to `main.{date}.{index}.log`. Both paths are fixed under
   * `<appData>/Lograil` and cannot be customized.
   */
  receiveFromRenderer?: boolean;
}

/** Resolve `electron.app` (only meaningful inside a real Electron process). */
function getElectronApp(): App | undefined {
  if (!isElectronProcess()) return undefined;
  try {
    return getElectron().app;
  } catch {
    return undefined;
  }
}

/** Log directory: `<appData>/Lograil`, or the temp dir when Electron is absent. */
function defaultElectronLogDir(): string {
  let dir = tmpdir();
  const app = getElectronApp();
  if (app?.getPath) {
    try {
      // Store logs under `<appData>/Lograil` (e.g.
      // %APPDATA%/Lograil on Windows) rather than the OS logs dir.
      dir = join(app.getPath('appData'), 'Lograil');
    } catch {
      /* ignore */
    }
  }
  return dir;
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
        const mainPath = join(dir, 'main.log');
        transports.push(
          new RotatingFileTransport({
            path: mainPath,
            daily: true,
            // Main-process entries only: renderer entries are routed to the
            // dedicated renderer log file below.
            filter: (entry) => entry.metadata?.[RENDERER_PROCESS_MARKER] !== 'renderer',
            ...options.fileTransportOptions,
          }),
        );

        if (receiveFromRenderer) {
          const rendererPath = join(dir, 'renderer.log');
          transports.push(
            new RotatingFileTransport({
              path: rendererPath,
              daily: true,
              // Renderer entries only.
              filter: (entry) => entry.metadata?.[RENDERER_PROCESS_MARKER] === 'renderer',
              ...options.fileTransportOptions,
            }),
          );
        }
      }
      return transports;
    },
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
