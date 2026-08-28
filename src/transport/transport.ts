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
  /** Optional flush; awaited by `Logger.flush()`. */
  flush?(): void | Promise<void>;
  /** Optional teardown. */
  close?(): void | Promise<void>;
}
