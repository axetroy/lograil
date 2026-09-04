import type { LogEntry, LogLevelInput } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';

/**
 * A Transport is the final sink of a log entry. Examples: console, file,
 * IPC to the Electron main process, or HTTP remote reporting.
 *
 * `write` may be synchronous or async. When async, the Logger awaits it
 * during a `flush()`.
 */
export interface Transport {
  /** Unique transport name, used for diagnostics and removal. */
  readonly name: string;
  /** Optional per-transport formatter, overrides the pipeline default. */
  readonly formatter?: Formatter;
  /**
   * Optional minimum level for this transport, as a name (`'info'`) or number.
   * Entries below this level are skipped by this transport (the logger-level
   * filter still applies first). Lets you route, e.g., `error`+ to a remote
   * sink while sending everything to a file.
   */
  readonly level?: LogLevelInput;
  /** Emit a processed entry. */
  write(entry: LogEntry, formatted: string): void | Promise<void>;
  /**
   * Optional hook invoked by the logger when `write` (or the promise it
   * returns) fails, so a broken sink can be reported without throwing out of
   * the caller's `log.*` call. The original entry is passed for context.
   */
  onError?(err: unknown, entry: LogEntry): void;
  /** Optional flush; awaited by `Logger.flush()`. */
  flush?(): void | Promise<void>;
  /** Optional teardown. */
  close?(): void | Promise<void>;
  /**
   * Maximum pending async-write queue depth for this transport. When the
   * queue exceeds this length, the newest entry is dropped immediately and
   * `onOverflow` is called (if provided). A value of `0` disables the limit
   * (the global {@link LoggerOptions.maxQueueDepth} then applies if set).
   */
  queueLimit?: number;
  /**
   * Called when this transport's queue is full and an entry must be dropped.
   * Receives the dropped entry and the current queue depth at drop time.
   */
  onOverflow?(entry: LogEntry, queueDepth: number): void;
}
