import type { LogEntry } from '../types.js';
import { isEmptyRecord } from '../context/context.js';

/**
 * A Formatter converts a structured {@link LogEntry} into a string (or any
 * serializable value) that a {@link Transport} writes to its destination.
 */
export type Formatter<T = string> = (entry: LogEntry) => T;

/** Structured representation of an {@link Error} for the JSON formatter. */
function errorToJson(err: unknown, seen = new WeakSet<object>()): Record<string, unknown> {
  if (err == null || typeof err !== 'object') return { value: err };
  if (seen.has(err)) {
    return {
      name: (err as { name?: string }).name,
      message: (err as { message?: string }).message,
      circular: true,
    };
  }
  seen.add(err);
  const cause = (err as { cause?: unknown }).cause;
  const causeValue =
    cause !== undefined
      ? cause instanceof Error
        ? errorToJson(cause, seen)
        : safeStringify(cause)
      : undefined;
  return {
    name: (err as { name?: string }).name,
    message: (err as { message?: string }).message,
    stack: (err as { stack?: string }).stack,
    cause: causeValue,
  };
}

/** One-line `Name: message; caused by: ...` form for inline (args) rendering. */
function formatErrorShort(err: unknown, seen = new WeakSet<object>()): string {
  if (err == null || typeof err !== 'object') return String(err);
  if (seen.has(err)) return '[Circular]';
  seen.add(err);
  const name = (err as { name?: string }).name ?? 'Error';
  const message = (err as { message?: string }).message ?? String(err);
  const cause = (err as { cause?: unknown }).cause;
  let out = `${name}: ${message}`;
  if (cause !== undefined) {
    out += `; caused by: ${
      cause instanceof Error ? formatErrorShort(cause, seen) : safeStringify(cause)
    }`;
  }
  return out;
}

/** Full stack form for the entry-level error, including the cause chain. */
function formatErrorChain(err: unknown, seen = new WeakSet<object>()): string {
  if (err == null || typeof err !== 'object') return String(err);
  if (seen.has(err)) return '[Circular cause]';
  seen.add(err);
  const stack = (err as { stack?: string }).stack;
  const name = (err as { name?: string }).name;
  const message = (err as { message?: string }).message;
  let out = stack ?? `${name ?? 'Error'}: ${message ?? String(err)}`;
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined) {
    out += `\ncaused by: ${
      cause instanceof Error ? formatErrorChain(cause, seen) : safeStringify(cause)
    }`;
  }
  return out;
}

/**
 * Cheap check used to skip the slower `JSON.stringify` replacer for the common
 * case. Returns true when `value` serializes to exactly the same string as the
 * safe replacer would: plain JSON data with no `Error`/`Map`/`Set`/function/
 * bigint/symbol, and not circular (circular plain objects make `JSON.stringify`
 * throw, and the caller falls back to the safe replacer).
 */
function isPlainJsonable(v: unknown, seen: WeakSet<object>): boolean {
  if (v === null) return true;
  switch (typeof v) {
    case 'string':
    case 'number':
    case 'boolean':
      return true;
    case 'object': {
      if (v instanceof Error || v instanceof Map || v instanceof Set) return false;
      if (seen.has(v)) return true; // circular plain object — caller falls back
      seen.add(v);
      if (Array.isArray(v)) {
        for (const item of v) {
          if (!isPlainJsonable(item, seen)) return false;
        }
      } else {
        for (const key in v) {
          if (!isPlainJsonable((v as Record<string, unknown>)[key], seen)) return false;
        }
      }
      return true;
    }
    case 'undefined':
      return true; // JSON.stringify drops `undefined` keys, identical to the replacer
    default:
      return false; // bigint / symbol / function
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') {
    return `[Function: ${(value as { name?: string }).name || 'anonymous'}]`;
  }
  if (value === undefined) return 'undefined';
  if (value instanceof Error) return formatErrorShort(value);
  if (value instanceof Map) return `Map(${value.size}) ${safeStringify([...value.entries()])}`;
  if (value instanceof Set) return `Set(${value.size}) ${safeStringify([...value.values()])}`;

  // Fast path: plain JSON-serializable data — `JSON.stringify` without the
  // per-key replacer is significantly faster, and produces identical output.
  if (typeof value === 'object' && value !== null) {
    const seen = new WeakSet<object>();
    if (isPlainJsonable(value, seen)) {
      try {
        return JSON.stringify(value);
      } catch {
        /* circular — fall through to the safe replacer */
      }
    }
  }

  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_k, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (typeof val === 'bigint') return `${val}n`;
      if (typeof val === 'symbol') return val.toString();
      if (typeof val === 'function') {
        return `[Function: ${(val as { name?: string }).name || 'anonymous'}]`;
      }
      if (val instanceof Error) return errorToJson(val);
      if (val instanceof Map) return { __type: 'Map', entries: [...val.entries()] };
      if (val instanceof Set) return { __type: 'Set', values: [...val.values()] };
      return val;
    });
  } catch {
    return String(value);
  }
}

export function createLineFormatter(): Formatter<string> {
  return (entry) => {
    const scope = entry.scope ? ` [${entry.scope}]` : '';
    const ctx = isEmptyRecord(entry.context) ? '' : ` ${safeStringify(entry.context)}`;
    const meta = isEmptyRecord(entry.metadata) ? '' : ` ${safeStringify(entry.metadata)}`;
    const err = entry.error ? `\n${formatErrorChain(entry.error)}` : '';
    const args = entry.args.length ? ` ${entry.args.map(safeStringify).join(' ')}` : '';
    return `${entry.time} ${entry.levelName.toUpperCase()}${scope}: ${entry.message}${args}${ctx}${meta}${err}`;
  };
}

/** Options for {@link createJsonFormatter}. */
export interface JsonFormatterOptions {
  /**
   * When `true`, `context` and `metadata` fields are spread into the top level
   * of the JSON object instead of being nested. Useful for backends (Loki,
   * Elasticsearch) that expect flat labels. Top-level fields (`message`,
   * `level`, …) are emitted first, so a colliding context key overrides them.
   */
  flatten?: boolean;
}

export function createJsonFormatter(options: JsonFormatterOptions = {}): Formatter<string> {
  const flatten = options.flatten ?? false;
  return (entry) => {
    const error = entry.error ? errorToJson(entry.error) : undefined;
    const base = {
      time: entry.time,
      level: entry.levelName,
      scope: entry.scope,
      pid: entry.pid,
      message: entry.message,
      args: entry.args,
    };
    const obj = flatten
      ? { ...base, ...entry.context, ...entry.metadata, error }
      : { ...base, context: entry.context, metadata: entry.metadata, error };
    return safeStringify(obj);
  };
}
