import { describe, it, expect } from 'vitest';
import { freezeEntry } from '../src/core/entry.js';
import { Logger } from '../src/core/logger.js';
import type { LogEntry } from '../src/types.js';
import { LOG_LEVELS } from '../src/types.js';

function makeEntry(): LogEntry {
  return {
    level: LOG_LEVELS.info,
    levelName: 'info',
    message: 'hi',
    args: [1, 2],
    timestamp: 1,
    time: '',
    context: { a: 1 },
    metadata: { b: 2 },
  };
}

describe('freezeEntry — immutable contract', () => {
  it('freezes the entry and its context/metadata/args containers', () => {
    const f = freezeEntry(makeEntry());
    expect(Object.isFrozen(f)).toBe(true);
    expect(Object.isFrozen(f.context)).toBe(true);
    expect(Object.isFrozen(f.metadata)).toBe(true);
    expect(Object.isFrozen(f.args)).toBe(true);
  });

  it('is idempotent and returns the same reference when already frozen', () => {
    const e = makeEntry();
    const f1 = freezeEntry(e);
    const f2 = freezeEntry(f1);
    expect(f1).toBe(f2);
  });

  it('copies context into an independent frozen snapshot', () => {
    const e = makeEntry();
    const source = e.context;
    const f = freezeEntry(e);
    source.a = 999; // mutate the original after freezing
    expect(f.context.a).toBe(1);
  });

  it('does not deep-freeze nested values (keeps zero-copy promise)', () => {
    const e = makeEntry();
    (e.context as Record<string, unknown>).nested = { x: 1 };
    const f = freezeEntry(e);
    const nested = (f.context as Record<string, unknown>).nested as object;
    expect(Object.isFrozen(nested)).toBe(false);
  });
});

describe('Logger hands transports an immutable (frozen) entry', () => {
  it('transports receive a frozen entry; later context changes do not leak in', () => {
    const seen: LogEntry[] = [];
    const logger = new Logger({
      transports: [
        {
          name: 'spy',
          write(entry) {
            seen.push(entry);
          },
        },
      ],
    });
    logger.setContext('reqId', 'r1');
    logger.info('hello');
    logger.setContext('reqId', 'r2'); // mutate after the entry was emitted

    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(seen[0].context.reqId).toBe('r1');
    expect(seen[0].context.reqId).not.toBe('r2');
  });

  it('a transport cannot mutate the shared entry (frozen) without crashing the call', () => {
    const transport = {
      name: 'mutator',
      write(entry: LogEntry) {
        // Under strict mode this throws; either way it must not break logging.
        try {
          (entry.metadata as Record<string, unknown>).tampered = true;
        } catch {
          /* strict-mode assignment to a frozen property rejects */
        }
      },
    };
    const logger = new Logger({ transports: [transport] });
    expect(() => logger.info('x')).not.toThrow();
  });
});
