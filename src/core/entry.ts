import type { LogEntry } from '../types.js';

/**
 * An entry that has crossed the immutability boundary: the entry itself and its
 * `context`, `metadata` and `args` containers are frozen. Nested values are
 * intentionally NOT deep-frozen (that would defeat the zero-copy goal) and must
 * be treated as immutable by convention.
 */
export type FrozenLogEntry = Readonly<LogEntry> & {
  readonly context: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly args: readonly unknown[];
};

/**
 * Freeze a {@link LogEntry} at its transport boundary so it can be shared by
 * reference (zero-copy) across all transports, plugins and formatters without
 * any of them being able to mutate it.
 *
 * Behaviour:
 * - The entry and its `context` / `metadata` / `args` containers are frozen.
 * - When `context` is the logger's *live* ambient context (not already a frozen,
 *   safe object) it is first copied into a fresh frozen snapshot. This prevents
 *   us from freezing the logger's shared state and ensures an already-emitted
 *   entry can never be mutated by a later `setContext`.
 * - It is a no-op (and idempotent) when the entry is already frozen.
 *
 * Nested values are left unfrozen on purpose: deep-freezing a potentially large
 * object graph on every log call would erase the zero-copy performance benefit.
 */
export function freezeEntry<T extends LogEntry>(entry: T): T & FrozenLogEntry {
  if (Object.isFrozen(entry)) return entry as T & FrozenLogEntry;

  const ctx = entry.context;
  (entry as { context: Record<string, unknown> }).context = Object.isFrozen(ctx)
    ? ctx
    : Object.freeze({ ...ctx });

  const meta = entry.metadata;
  (entry as { metadata: Record<string, unknown> }).metadata = Object.isFrozen(meta)
    ? meta
    : Object.freeze({ ...meta });

  if (!Object.isFrozen(entry.args)) Object.freeze(entry.args);

  return Object.freeze(entry) as T & FrozenLogEntry;
}
