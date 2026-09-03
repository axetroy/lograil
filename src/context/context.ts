/**
 * Context module.
 *
 * Manages structured contextual data (request id, user id, window id, etc.)
 * that is attached to every log entry. Contexts are hierarchical:
 * a global context provides defaults for all loggers, and child loggers
 * can carry their own scoped context.
 */

export interface ContextStore {
  /** Read the full context object. */
  get(): Record<string, unknown>;
  /** Set a single key. */
  set(key: string, value: unknown): void;
  /** Merge multiple keys at once. Returns the store for chaining. */
  merge(values: Record<string, unknown>): ContextStore;
  /** Remove a single key. */
  delete(key: string): void;
  /** Reset the store to empty. */
  clear(): void;
  /** Create a child store seeded with the current values. */
  child(): ContextStore;
}

const EMPTY_CONTEXT = Object.freeze({}) as Record<string, unknown>;

/**
 * A shared, frozen empty record. Returned by `ContextStore.get()` when empty
 * and used as the default `metadata` for every entry, so the hot path never
 * allocates an empty object — and `freezeEntry` can recognise it as a sentinel
 * and skip cloning/freezing entirely.
 */
export const EMPTY_RECORD = EMPTY_CONTEXT;

/** True when the record has no own enumerable keys. */
export function isEmptyRecord(o: Record<string, unknown>): boolean {
  for (const _k in o) return false;
  return true;
}

export function createContextStore(initial?: Record<string, unknown>): ContextStore {
  let data: Record<string, unknown> = { ...(initial ?? {}) };

  const store: ContextStore = {
    get() {
      // Avoid cloning (and allocating) when the store is empty — the shared
      // frozen object can never be mutated by callers.
      for (const _k in data) return Object.assign({}, data);
      return EMPTY_CONTEXT;
    },
    set(key, value) {
      data[key] = value;
    },
    merge(values) {
      data = { ...data, ...values };
      return store;
    },
    delete(key) {
      delete data[key];
    },
    clear() {
      data = {};
    },
    child() {
      return createContextStore(data);
    },
  };

  return store;
}
