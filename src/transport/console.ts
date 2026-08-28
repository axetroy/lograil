import type { LogEntry } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';
import { createLineFormatter } from '../pipeline/formatter.js';
import type { Transport } from './transport.js';

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
      trace: console.trace,
      debug: console.debug,
      info: console.info,
      warn: console.warn,
      error: console.error,
      fatal: console.error,
      ...options.methodMap,
    };
  }

  write(entry: LogEntry, formatted: string): void {
    const fn = this.methodMap[entry.levelName] ?? console.log;
    fn(formatted);
  }
}
