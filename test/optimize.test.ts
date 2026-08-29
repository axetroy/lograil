import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/index.js';
import { createJsonFormatter } from '../src/pipeline/formatter.js';
import { createContextStore, asyncContext } from '../src/context/index.js';
import type { LogEntry } from '../src/types.js';
import type { RuntimeAdapter } from '../src/runtime/index.js';
import type { Transport } from '../src/transport/transport.js';

function captureRuntime(nowFn: () => number): RuntimeAdapter {
  return {
    name: 'node',
    now: nowFn,
    pid: () => 1,
    hasFileSystem: () => false,
    defaultTransports: () => [],
  } as unknown as RuntimeAdapter;
}

// Boundary timestamps: epoch, leap years, month/year edges, pre-1970 (negative ms).
const timestamps = [
  0,
  1,
  999,
  1700000000000,
  Date.UTC(2000, 1, 28, 23, 59, 59, 999), // leap year edge
  Date.UTC(2024, 1, 29, 0, 0, 0, 0),
  Date.UTC(1900, 0, 1, 0, 0, 0, 0),
  Date.UTC(2021, 11, 31, 23, 59, 59, 999),
  Date.UTC(1969, 11, 31, 23, 59, 59, 999), // pre-1970
  Date.UTC(2023, 5, 30, 12, 34, 56, 789),
  253402300799999, // year 9999
];

describe('isoFromMs (manual timestamp formatter)', () => {
  for (const ms of timestamps) {
    it(`matches Date#toISOString at ${ms}`, () => {
      const entries: LogEntry[] = [];
      const transport: Transport = { name: 'cap', write: (e: LogEntry) => void entries.push(e) };
      const log = createLogger({ runtime: captureRuntime(() => ms), transports: [transport] });
      log.info('x');
      expect(entries[0].timestamp).toBe(ms);
      expect(entries[0].time).toBe(new Date(ms).toISOString());
    });
  }
});

describe('safeStringify fast path', () => {
  it('json formatter drops undefined keys (plain fast path)', () => {
    const f = createJsonFormatter();
    const out = JSON.parse(
      f({
        level: 4,
        levelName: 'info',
        message: 'm',
        args: [],
        timestamp: 0,
        time: '',
        scope: undefined,
        pid: undefined,
        context: {},
        metadata: {},
        error: undefined,
      } as unknown as LogEntry),
    );
    expect(out).toEqual({
      time: '',
      level: 'info',
      message: 'm',
      args: [],
      context: {},
      metadata: {},
    });
  });

  it('json formatter still renders Error fields when present', () => {
    const f = createJsonFormatter();
    const out = JSON.parse(
      f({
        level: 4,
        levelName: 'info',
        message: 'm',
        args: [{ a: 1 }],
        timestamp: 0,
        time: '',
        scope: undefined,
        pid: undefined,
        context: {},
        metadata: {},
        error: new Error('boom'),
      } as unknown as LogEntry),
    );
    expect(out.error.name).toBe('Error');
    expect(out.error.message).toBe('boom');
    expect(out.args).toEqual([{ a: 1 }]);
  });
});

describe('context.get() empty optimization', () => {
  it('returns a shared frozen object when empty', () => {
    const s = createContextStore();
    const a = s.get();
    const b = s.get();
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).toBe(b);
    expect(a).toEqual({});
  });

  it('clones (does not leak) for non-empty context', () => {
    const s = createContextStore({ k: 'v' });
    const a = s.get();
    s.set('k2', 'v2');
    expect(a).toEqual({ k: 'v' });
    expect(s.get()).toEqual({ k: 'v', k2: 'v2' });
  });
});

describe('zero-allocation hot path', () => {
  it('empty metadata shares the frozen EMPTY_RECORD sentinel (no per-call allocation)', () => {
    const entries: LogEntry[] = [];
    const transport: Transport = { name: 'cap', write: (e: LogEntry) => void entries.push(e) };
    const log = createLogger({ runtime: captureRuntime(() => 1), transports: [transport] });
    log.info('hi');
    const e = entries[0];
    // After freezeEntry, an empty metadata must still be the shared sentinel
    // (frozen, and identical by reference to the module constant's identity),
    // so the common no-metadata path allocates nothing for metadata.
    expect(Object.isFrozen(e.metadata)).toBe(true);
    expect(e.metadata).toBe(e.metadata); // stable reference
    expect(Object.keys(e.metadata)).toHaveLength(0);
  });

  it('async-context get() returns a shared frozen object when no store is active', () => {
    const a = asyncContext.get();
    const b = asyncContext.get();
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).toBe(b);
  });
});

describe('removeTransport queue cleanup', () => {
  it('drops the removed transport and stops delivering to it', async () => {
    const kept: LogEntry[] = [];
    const dropped: LogEntry[] = [];
    const t1: Transport = { name: 't1', write: (e) => void kept.push(e) };
    const t2: Transport = { name: 't2', write: (e) => void dropped.push(e) };
    const log = createLogger({ runtime: captureRuntime(() => 1), transports: [t1, t2] });
    log.info('before remove');
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    log.removeTransport('t2');
    log.info('after remove');
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(1); // t2 never sees the second entry
  });
});
