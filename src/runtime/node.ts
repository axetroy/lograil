import type { Transport } from '../transport/transport.js';
import { ConsoleTransport } from '../transport/console.js';
import type { RotatingFileTransportOptions } from '../transport/rotating-file.js';
import { RotatingFileTransport } from '../transport/rotating-file.js';
import type { RuntimeAdapter } from './adapter.js';
import { createProcessLifecycle } from './process-lifecycle.js';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

export interface NodeRuntimeOptions {
  /**
   * Explicit log file path. When omitted, a rotating file in the system temp
   * directory is used — the library writes logs by default.
   */
  logFile?: string;
  /** Application name used to derive the default log path. */
  appName?: string;
  fileTransportOptions?: Partial<RotatingFileTransportOptions>;
  /** Disable the file transport entirely (console only). */
  disableFile?: boolean;
}

function defaultNodeLogPath(appName?: string): string {
  let name = appName;
  if (!name) {
    try {
      const p = process.argv[1];
      if (p) name = basename(p).replace(/\.[^.]+$/, '');
    } catch {
      /* ignore */
    }
  }
  return join(tmpdir(), `${name ?? 'app'}.log`);
}

/**
 * Plain Node.js runtime (CLI / server / worker). Has both a process id and
 * filesystem access, so by default it persists logs to a rotating file (in
 * addition to the console). Pass `disableFile` to opt out, or `logFile` /
 * `appName` / `fileTransportOptions` to customize.
 */
export function createNodeRuntime(options: NodeRuntimeOptions = {}): RuntimeAdapter {
  const pid = typeof process !== 'undefined' ? process.pid : undefined;
  return {
    name: 'node',
    now: () => Date.now(),
    pid: () => pid,
    hasFileSystem: () => true,
    defaultTransports: () => {
      const transports: Transport[] = [new ConsoleTransport()];
      if (!options.disableFile) {
        const filePath = options.logFile ?? defaultNodeLogPath(options.appName);
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
    // Flush on process exit / signals via the shared Node lifecycle hooks.
    lifecycle: createProcessLifecycle(),
  };
}
