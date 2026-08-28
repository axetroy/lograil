import type { LogLevelName, LogLevelValue, LogLevelInput } from '../types.js';
import { LOG_LEVELS, normalizeLevel } from '../types.js';

export { LOG_LEVELS };

export type { LogLevelName, LogLevelValue, LogLevelInput };

/**
 * Resolve a level name from a numeric value, falling back to the closest
 * lower-known level when the exact value is not registered.
 */
export function levelNameFromValue(value: LogLevelValue): LogLevelName {
  let best: LogLevelName = 'trace';
  let bestValue = -Infinity;
  for (const name of Object.keys(LOG_LEVELS) as LogLevelName[]) {
    const lv = LOG_LEVELS[name];
    if (lv <= value && lv > bestValue) {
      best = name;
      bestValue = lv;
    }
  }
  return best;
}

export function compareLevel(a: LogLevelInput, b: LogLevelInput): number {
  return normalizeLevel(a) - normalizeLevel(b);
}

export function isLevelEnabled(configured: LogLevelInput, candidate: LogLevelInput): boolean {
  return normalizeLevel(candidate) >= normalizeLevel(configured);
}
