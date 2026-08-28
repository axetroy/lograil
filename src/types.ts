/**
 * Shared type definitions for the logging library.
 *
 * These types form the stable contract used across Core, Pipeline,
 * Transport, Runtime and Plugin modules.
 */

export type LogLevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type LogLevelValue = number;

/**
 * Ordered by severity. Higher value means more severe.
 */
export const LOG_LEVELS: Record<LogLevelName, LogLevelValue> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export const LOG_LEVEL_NAMES = Object.keys(LOG_LEVELS) as LogLevelName[];

export function isLogLevelName(value: unknown): value is LogLevelName {
  return typeof value === 'string' && value in LOG_LEVELS;
}

/**
 * A single structured log record produced by the Logger.
 */
export interface LogEntry {
  /** Numeric severity, see {@link LOG_LEVELS}. */
  level: LogLevelValue;
  /** Human readable level name. */
  levelName: LogLevelName;
  /** Primary message text. */
  message: string;
  /** Extra positional arguments passed to the log call. */
  args: unknown[];
  /** Epoch milliseconds when the entry was created. */
  timestamp: number;
  /** Coarse ISO timestamp for display / serialization. */
  time: string;
  /** Scope / namespace, e.g. child logger name. */
  scope?: string;
  /** Process id when available (Electron main / Node). */
  pid?: number;
  /** Persistent contextual fields (see Context module). */
  context: Record<string, unknown>;
  /** One-off metadata attached to this entry only. */
  metadata: Record<string, unknown>;
  /** Error object when the entry was created from one. */
  error?: Error;
}

export type LogFn = (message: unknown, ...args: unknown[]) => void;

export interface LoggerMethods {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
}

export type LogLevelInput = LogLevelName | LogLevelValue;

export function normalizeLevel(input: LogLevelInput): LogLevelValue {
  if (typeof input === 'number') {
    return input;
  }
  const value = LOG_LEVELS[input];
  if (value === undefined) {
    throw new Error(`Unknown log level: ${String(input)}`);
  }
  return value;
}
