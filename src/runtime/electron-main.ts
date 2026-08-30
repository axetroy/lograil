import type { RuntimeAdapter } from './adapter.js';
import type { Transport } from '../transport/transport.js';
import { ConsoleTransport } from '../transport/console.js';
import type { RotateTimeOptions } from '../transport/file.js';
import { FileTransport } from '../transport/file.js';
import { registerIpcReceiver, RENDERER_PROCESS_MARKER } from '../transport/electron-ipc.js';
import { getElectronApp } from './electron-binding.js';
import { createElectronLifecycle } from './electron-lifecycle.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ElectronMainRuntimeOptions {
  /** Forwarded to the main/renderer `FileTransport` (mode `rotate-time`). */
  fileTransportOptions?: Partial<Omit<RotateTimeOptions, 'mode'>>;
  /** Disable the file transport entirely (console only). */
  disableFile?: boolean;
  /**
   * Listen for renderer entries over IPC and write them to the dedicated
   * `renderer.{date}.log` file (default `true`). Main-process entries
   * go to `main.{date}.log`. Both paths are fixed under `<appData>/Lograil`
   * and cannot be customized.
   */
  receiveFromRenderer?: boolean;
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
