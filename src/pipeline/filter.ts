import type { LogEntry } from '../types.js';

/**
 * A Filter decides whether a log entry should continue through the pipeline.
 * Returning `true` keeps the entry, `false` drops it.
 */
export type Filter = (entry: LogEntry) => boolean;

export function createLevelFilter(minLevel: number): Filter {
  return (entry) => entry.level >= minLevel;
}

export function createScopeFilter(allowed: string[]): Filter {
  const set = new Set(allowed);
  return (entry) => !entry.scope || set.has(entry.scope);
}

export function combineFilters(filters: Filter[]): Filter {
  return (entry) => filters.every((f) => f(entry));
}
