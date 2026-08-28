import type { Transport } from '../transport/transport.js';
import type { LogEntry } from '../types.js';

/**
 * Supported runtime environments:
 *  - `web`       : browsers, no filesystem / process id.
 *  - `node`      : plain Node.js (CLI / server), has filesystem and process id.
 *  - `electron`  : Electron, further differentiated by {@link processType}.
 */
export type RuntimeName = 'web' | 'node' | 'electron';

/**
 * For Electron, whether we run in the main process (owns the filesystem) or a
 * renderer process (sandboxed, console only by default).
 */
export type ElectronProcessType = 'main' | 'renderer';

/** Callback that feeds a received entry back into a logger. */
export type IngestFn = (entry: LogEntry) => void;

/**
 * RuntimeAdapter isolates differences between the Web, Node.js and Electron
 * environments: time source, process id, filesystem availability and the set
 * of transports enabled by default.
 */
export interface RuntimeAdapter {
  readonly name: RuntimeName;
  /** `main` / `renderer` for Electron, otherwise `undefined`. */
  readonly processType?: ElectronProcessType;
  /** Current epoch milliseconds. */
  now(): number;
  /** Process id when available (Electron main / Node). */
  pid(): number | undefined;
  /** Whether persistent local file storage is available. */
  hasFileSystem(): boolean;
  /** Transports enabled by default for this runtime. */
  defaultTransports(): Transport[];
  /**
   * For Electron main process: register a receiver that forwards entries sent
   * by renderer processes (via IPC) into the host logger. Returns an
   * unregister function. Undefined when not applicable.
   */
  attachReceiver?: (ingest: IngestFn) => () => void;
}
