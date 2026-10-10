import type { LogLevelName, LogLevelValue, LogLevelInput } from '../types.js';
import { LOG_LEVELS, normalizeLevel } from '../types.js';
import { listCustomLevels, lookupLevel } from './level-registry.js';

export { LOG_LEVELS };

export type { LogLevelName, LogLevelValue, LogLevelInput };

/**
 * Resolve a level name from a numeric value, falling back to the closest
 * lower-known level when the exact value is not registered. Consults the
 * custom-level registry so a user-registered name (e.g. `audit`) resolves
 * correctly instead of snapping to the nearest built-in.
 */
export function levelNameFromValue(value: LogLevelValue): LogLevelName {
  let best: string = 'trace';
  let bestValue = -Infinity;
  const names = [...(Object.keys(LOG_LEVELS) as LogLevelName[]), ...listCustomLevels()];
  for (const name of names) {
    const lv = lookupLevel(name);
    if (lv !== undefined && lv <= value && lv > bestValue) {
      best = name;
      bestValue = lv;
    }
  }
  return best as LogLevelName;
}

export function compareLevel(a: LogLevelInput, b: LogLevelInput): number {
  return normalizeLevel(a) - normalizeLevel(b);
}

export function isLevelEnabled(configured: LogLevelInput, candidate: LogLevelInput): boolean {
  return normalizeLevel(candidate) >= normalizeLevel(configured);
}
