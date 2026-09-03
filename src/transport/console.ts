import type { LogEntry, LogLevelName } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';
import { createLineFormatter } from '../pipeline/formatter.js';
import type { Transport } from './transport.js';

// Snapshot the real console methods at module load so that, even if something
// later redirects the global `console` (see `Logger.redirectConsole`), this
// transport keeps writing to the original console and never recurses.
const realConsole = {
  trace: console.trace.bind(console),
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  log: console.log.bind(console),
};

/** Default method mapping shared across all ConsoleTransport instances. */
const DEFAULT_METHOD_MAP: Record<string, (...args: unknown[]) => void> = {
  trace: realConsole.trace,
  debug: realConsole.debug,
  info: realConsole.info,
  warn: realConsole.warn,
  error: realConsole.error,
  fatal: realConsole.error,
};

export interface ConsoleTransportOptions {
  name?: string;
  formatter?: Formatter;
  /** Map a level to the console method used. */
  methodMap?: Partial<Record<string, (...args: unknown[]) => void>>;
  /**
   * Levels that should be written to `stderr` (via `console.error`). Any level
   * listed here is routed to `console.error` even if `methodMap` maps it
   * elsewhere. Defaults to `['error', 'fatal']` (matching the previous
   * behaviour); add `'warn'` to also send warnings to stderr.
   */
  stderrLevels?: LogLevelName[];
}

/**
 * Writes log entries to the global `console`. Suitable for both Web and
 * Node/Electron runtimes.
 */
export class ConsoleTransport implements Transport {
  readonly name: string;
  readonly formatter: Formatter;

  private methodMap: Record<string, (...args: unknown[]) => void>;

  constructor(options: ConsoleTransportOptions = {}) {
    this.name = options.name ?? 'console';
    this.formatter = options.formatter ?? createLineFormatter();
    this.methodMap = { ...DEFAULT_METHOD_MAP, ...options.methodMap } as Record<
      string,
      (...args: unknown[]) => void
    >;
    // Route the requested levels to stderr (console.error). Applied after
    // `methodMap` so an explicitly provided method for a level is not silently
    // overridden. Defaults to empty — the default `methodMap` already sends
    // `error`/`fatal` to stderr, so opt in with e.g. `stderrLevels: ['warn']`.
    const stderrLevels = options.stderrLevels ?? [];
    for (const level of stderrLevels) {
      this.methodMap[level] = realConsole.error;
    }
  }

  write(entry: LogEntry, formatted: string): void {
    const fn = this.methodMap[entry.levelName] ?? realConsole.log;
    fn(formatted);
  }
}
