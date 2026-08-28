import type { RuntimeAdapter } from './adapter.js';
import type { Transport } from '../transport/transport.js';
import { ConsoleTransport } from '../transport/console.js';
import type { RotatingFileTransportOptions } from '../transport/rotating-file.js';
import { RotatingFileTransport } from '../transport/rotating-file.js';
import { registerIpcReceiver } from '../transport/electron-ipc.js';
import { getElectron, isElectronProcess } from './electron-binding.js';
import type { App } from 'electron';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

export interface ElectronMainRuntimeOptions {
  /**
   * Explicit log file path. When omitted, a rotating file inside
   * `<appData>/Lograil` (Electron `app.getPath('appData')`, falling
   * back to the temp dir) is used — the library writes logs by default.
   */
  logFile?: string;
  /** Application name used to derive the default log path. */
  appName?: string;
  fileTransportOptions?: Partial<RotatingFileTransportOptions>;
  /** Disable the file transport entirely (console only). */
  disableFile?: boolean;
  /**
   * Listen for renderer entries over IPC and write them here (default `true`).
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

function defaultElectronLogPath(appName?: string): string {
  const app = getElectronApp();
  let name = appName;
  if (!name && app?.getName) {
    try {
      name = app.getName();
    } catch {
      /* ignore */
    }
  }
  let dir = tmpdir();
  if (app?.getPath) {
    try {
      // Store logs under `<appData>/Lograil` (e.g.
      // %APPDATA%/Lograil on Windows) rather than the OS logs dir.
      dir = join(app.getPath('appData'), 'Lograil');
    } catch {
      /* ignore */
    }
  }
  if (!name) {
    try {
      const p = process.argv[1];
      if (p) name = basename(p).replace(/\.[^.]+$/, '');
    } catch {
      /* ignore */
    }
  }
  return join(dir, `${name ?? 'app'}.log`);
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
        const filePath = options.logFile ?? defaultElectronLogPath(options.appName);
        transports.push(
          new RotatingFileTransport({
            path: filePath,
            daily: true,
            ...options.fileTransportOptions,
          }),
        );
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
