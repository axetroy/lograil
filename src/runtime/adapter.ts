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
 * Host lifecycle hooks. A runtime implements these to tell the logger *when*
 * it should flush pending entries before the host goes away (process exit,
 * page unload, app quit) and *when* a fatal, uncaught host error occurs.
 *
 * The logger supplies the actual flush/fatal behaviour (and its timeout
 * safety); the runtime owns the trigger and any host-specific exit semantics
 * (e.g. `process.exit` on a signal, or simply letting the browser unload).
 * This keeps {@link Logger} runtime-agnostic — it never references `process`
 * or `window` directly.
 */
export interface LifecycleHooks {
  /**
   * Register `cb` to run when the host is about to exit/close. The runtime
   * decides the actual trigger (Node/Electron `process` `beforeExit`/signals,
   * Web `pagehide`/`visibilitychange`, Electron `app` `before-quit`) and owns
   * any `process.exit()` it needs. Returns an unregister function; a no-op
   * host returns a no-op detach.
   */
  onFlushBeforeExit(cb: () => void | Promise<void>): () => void;
  /**
   * Register `cb` for fatal, uncaught host errors (Node/Electron
   * `uncaughtException` / `unhandledRejection`). Optional — omit it on runtimes
   * with no such concept (e.g. web). Returns an unregister function.
   */
  onUncaughtError?(cb: (err: unknown) => void): () => void;
}

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
  /**
   * Cross-process level-setting callback. When set on the runtime, any
   * `setLevel` call from a child process will invoke this with the new level.
   * Undefined when not applicable.
   */
  onLevelCommand?: (level: number) => void;
  /**
   * Host lifecycle hooks. When present, the logger wires its flush-on-exit and
   * crash-logging behaviour through these instead of touching `process` /
   * `window` itself. Omit (or leave `undefined`) on runtimes where the logger
   * should not react to host lifecycle.
   */
  lifecycle?: LifecycleHooks;
}
