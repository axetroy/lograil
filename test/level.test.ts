import { describe, it, expect } from 'vitest';
import { LOG_LEVELS, isLogLevelName, normalizeLevel } from '../src/types.js';
import { levelNameFromValue, compareLevel, isLevelEnabled } from '../src/core/level.js';

describe('Level utilities', () => {
  it('normalizes names to numeric values', () => {
    expect(normalizeLevel('info')).toBe(LOG_LEVELS.info);
    expect(normalizeLevel(42)).toBe(42);
  });

  it('throws on unknown level name', () => {
    expect(() => normalizeLevel('nope' as never)).toThrow(/Unknown log level/);
  });

  it('identifies valid level names', () => {
    expect(isLogLevelName('warn')).toBe(true);
    expect(isLogLevelName('x')).toBe(false);
    expect(isLogLevelName(10)).toBe(false);
  });

  it('resolves a name from a numeric value', () => {
    expect(levelNameFromValue(LOG_LEVELS.error)).toBe('error');
    expect(levelNameFromValue(35)).toBe('info'); // rounds down to nearest
    expect(levelNameFromValue(5)).toBe('trace');
  });

  it('compares levels', () => {
    expect(compareLevel('debug', 'info')).toBeLessThan(0);
    expect(compareLevel('error', 'error')).toBe(0);
  });

  it('checks whether a level is enabled', () => {
    expect(isLevelEnabled('warn', 'error')).toBe(true);
    expect(isLevelEnabled('warn', 'info')).toBe(false);
    expect(isLevelEnabled(40, 40)).toBe(true);
  });
});
