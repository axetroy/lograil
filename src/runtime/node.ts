import type { Transport } from '../transport/transport.js';
import { ConsoleTransport } from '../transport/console.js';
import type { RotateTimeOptions } from '../transport/file.js';
import { FileTransport } from '../transport/file.js';
import { ClusterIpcTransport, registerClusterReceiver } from '../transport/cluster-ipc.js';
import type { RuntimeAdapter } from './adapter.js';
import { createProcessLifecycle } from './process-lifecycle.js';
import { tmpdir } from '../shims/index.js';
import { basename } from '../shims/index.js';
import { isClusterWorker } from '../shims/index.js';
import { DEFAULT_FILE_CAPS } from './defaults.js';

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
 * Lifecycle hooks for cluster workers. Flushes on `disconnect` (the primary
 * closed the IPC channel) and on `beforeExit` / signals.
 */
function createClusterWorkerLifecycle() {
  const lc = createProcessLifecycle();
  return {
    onFlushBeforeExit(cb: () => void | Promise<void>): () => void {
      const detachProcess = lc.onFlushBeforeExit(cb);
      const proc = process as unknown as {
        on?: (event: string, cb: () => void) => void;
        removeListener?: (event: string, cb: () => void) => void;
      };
      const onDisconnect = (): void => {
        void cb();
      };
      proc.on?.('disconnect', onDisconnect);
      return () => {
        detachProcess();
        proc.removeListener?.('disconnect', onDisconnect);
      };
    },
    onUncaughtError: lc.onUncaughtError as RuntimeAdapter['lifecycle'] extends undefined
      ? undefined
      : NonNullable<RuntimeAdapter['lifecycle']>['onUncaughtError'],
  };
}

/**
 * Plain Node.js runtime (CLI / server / worker). Has both a process id and
 * filesystem access, so by default it persists logs to a time-rotated file
 * (in addition to the console). Pass `disableFile` to opt out, or
 * `appName` / `fileTransportOptions` to customize. `appName` is required for
 * the file transport; if omitted it is inferred from the launched script and
 * throws if it cannot be determined.
 *
 * **Cluster support.** When running inside `node:cluster`, the runtime
 * automatically detects whether the current process is a worker or the
 * primary. Workers disable the file transport and send entries to the
 * primary via `process.send()` (the `ClusterIpcTransport`). The primary
 * receives those entries and feeds them into the logger — no manual
 * `registerClusterReceiver` call is needed.
 */
export function createNodeRuntime(options: NodeRuntimeOptions = {}): RuntimeAdapter {
  const pid = typeof process !== 'undefined' ? process.pid : undefined;
  const worker = isClusterWorker();

  // ── Cluster worker: no file, send to primary via IPC ──
  if (worker) {
    return {
      name: 'node',
      now: () => Date.now(),
      pid: () => pid,
      hasFileSystem: () => false,
      defaultTransports: (): Transport[] => [new ConsoleTransport(), new ClusterIpcTransport()],
      lifecycle: createClusterWorkerLifecycle(),
    };
  }

  // ── Primary or non-cluster: console + file (default) ──
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
        ...DEFAULT_FILE_CAPS,
        ...options.fileTransportOptions,
      }),
    );
  }

  return {
    name: 'node',
    now: () => Date.now(),
    pid: () => pid,
    hasFileSystem: () => !options.disableFile,
    defaultTransports: () => transports,
    attachReceiver: (ingest) => registerClusterReceiver(ingest),
    lifecycle: createProcessLifecycle(),
  };
}
