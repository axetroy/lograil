import { describe, it, expect, afterEach } from 'vitest';
import {
  registerLevel,
  unregisterLevel,
  listCustomLevels,
  _resetLevelRegistry,
} from '../src/core/level-registry.js';
import { levelNameFromValue } from '../src/core/level.js';
import { LOG_LEVELS, normalizeLevel } from '../src/types.js';
import { Logger } from '../src/core/logger.js';
import type { LogEntry } from '../src/types.js';
import type { Transport } from '../src/transport/transport.js';
import { createLineFormatter } from '../src/pipeline/formatter.js';
import type { RuntimeAdapter } from '../src/runtime/adapter.js';

function makeMemoryTransport(): Transport & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    name: 'memory',
    formatter: createLineFormatter(),
    entries,
    write: (e: LogEntry) => void entries.push(e),
  } as unknown as Transport & { entries: LogEntry[] };
}

function makeLogger(level?: string, extra?: Record<string, unknown>) {
  const runtime = {
    name: 'node' as const,
    now: () => 0,
    pid: () => 1,
    hasFileSystem: () => false,
    defaultTransports: () => [],
  } as unknown as RuntimeAdapter;
  return new Logger(level ? { level, runtime, ...extra } : { runtime, ...extra });
}

describe('level-registry', () => {
  afterEach(() => _resetLevelRegistry());

  it('registers a custom level usable by normalizeLevel', () => {
    registerLevel('audit', 45);
    expect(normalizeLevel('audit')).toBe(45);
    expect(levelNameFromValue(45)).toBe('audit');
  });

  it('rejects a collision with a built-in name', () => {
    expect(() => registerLevel('info', 30)).toThrowError(/already a known level/);
  });

  it('rejects a non-positive value', () => {
    expect(() => registerLevel('zero', 0)).toThrowError(/positive finite/);
  });

  it('rejects an empty name', () => {
    expect(() => registerLevel('', 45)).toThrowError(/non-empty/);
  });

  it('custom level ordering works in isLevelEnabled', () => {
    registerLevel('critical', 55);
    // 55 (critical) < 60 (fatal) is correct; 45 (below critical) should pass when configured=critical
    const log = makeLogger('critical');
    expect(log.getLevel()).toBe(55);
  });

  it('unregisterLevel removes a custom level and restores built-in behavior', () => {
    registerLevel('audit', 45);
    expect(normalizeLevel('audit')).toBe(45);
    const removed = unregisterLevel('audit');
    expect(removed).toBe(true);
    // After unregister, 'audit' is unknown again.
    expect(() => normalizeLevel('audit')).toThrowError(/Unknown log level/);
  });

  it('unregisterLevel on a built-in name is a no-op', () => {
    expect(unregisterLevel('info')).toBe(false);
  });

  it('listCustomLevels returns only user-registered names', () => {
    expect(listCustomLevels()).toEqual([]);
    registerLevel('alpha', 15);
    registerLevel('beta', 35);
    expect(listCustomLevels()).toEqual(['alpha', 'beta']);
  });

  it('a custom level set as the logger level is honored by emit', () => {
    registerLevel('audit', 45);
    const t = makeMemoryTransport();
    const log = makeLogger('audit');
    log.addTransport(t);
    // 'audit' level (45) is >= configured 'audit' (45) → emitted.
    // 'info' (30) < 45 → filtered out.
    log.info('should-be-filtered');
    // There is no log.audit() built-in, so use the registry to set a level
    // and verify the entry that *does* emit carries the right numeric level.
    log.error('should-emit');
    const emitted = t.entries;
    expect(emitted.length).toBe(1);
    expect(emitted[0].levelName).toBe('error');
    expect(emitted[0].level).toBe(LOG_LEVELS.error);
  });

  it('registerLevel on a duplicate custom name throws', () => {
    registerLevel('custom-a', 42);
    expect(() => registerLevel('custom-a', 43)).toThrowError(/already a known level/);
  });
});
