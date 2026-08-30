import type { Transport } from '../transport/transport.js';
import { ConsoleTransport } from '../transport/console.js';
import type { RotateTimeOptions } from '../transport/file.js';
import { FileTransport } from '../transport/file.js';
import type { RuntimeAdapter } from './adapter.js';
import { createProcessLifecycle } from './process-lifecycle.js';
import { tmpdir } from '../shims/index.js';
import { basename } from '../shims/index.js';

export interface NodeRuntimeOptions {
  /** Application name; embedded in the log file name (required). */
  appName?: string;
  /** Forwarded to the default `FileTransport` (mode `rotate-time`). */
  fileTransportOptions?: Partial<Omit<RotateTimeOptions, 'mode'>>;
  /** Disable the file transport entirely (console only). */
  disableFile?: boolean;
}

/** Derive an application name from the invoked script when none is given. */
function inferAppName(): string | undefined {
  try {
    const p = process.argv[1];
    if (p) return basename(p).replace(/\.[^.]+$/, '');
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Plain Node.js runtime (CLI / server / worker). Has both a process id and
 * filesystem access, so by default it persists logs to a time-rotated file
 * (in addition to the console). Pass `disableFile` to opt out, or
 * `appName` / `fileTransportOptions` to customize. `appName` is required for
 * the file transport; if omitted it is inferred from the launched script and
 * throws if it cannot be determined.
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
        const appName = options.appName ?? inferAppName();
        if (!appName) {
          throw new Error(
            'Node runtime requires an "appName" (or a determinable script path) for the file transport',
          );
        }
        transports.push(
          new FileTransport({
            mode: 'rotate-time',
            unit: 'day',
            appName,
            dir: tmpdir(),
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
