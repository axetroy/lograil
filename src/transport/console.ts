import type { LogEntry } from '../types.js';
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

export interface ConsoleTransportOptions {
  name?: string;
  formatter?: Formatter;
  /** Map a level to the console method used. */
  methodMap?: Partial<Record<string, (...args: unknown[]) => void>>;
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
    this.methodMap = {
      trace: realConsole.trace,
      debug: realConsole.debug,
      info: realConsole.info,
      warn: realConsole.warn,
      error: realConsole.error,
      fatal: realConsole.error,
      ...options.methodMap,
    };
  }

  write(entry: LogEntry, formatted: string): void {
    const fn = this.methodMap[entry.levelName] ?? realConsole.log;
    fn(formatted);
  }
}
