import { describe, it, expect, vi } from 'vitest';
import { createSampler } from '../src/pipeline/sampler.js';
import { LOG_LEVELS } from '../src/types.js';
import type { LogEntry, LogLevelName } from '../src/types.js';
import type { RuntimeAdapter } from '../src/runtime/adapter.js';
import type { Transport } from '../src/transport/transport.js';
import { Logger } from '../src/core/logger.js';

function entry(levelName: LogLevelName, timestamp = 1000): LogEntry {
  return {
    level: LOG_LEVELS[levelName],
    levelName,
    message: 'm',
    args: [],
    timestamp,
    time: '',
    context: {},
    metadata: {},
  } as unknown as LogEntry;
}

function makeLogger() {
  const runtime = {
    name: 'node',
    now: () => 0,
    pid: () => 1,
    hasFileSystem: () => false,
    defaultTransports: () => [],
  } as unknown as RuntimeAdapter;
  return new Logger({ level: 'info', runtime });
}

describe('createSampler', () => {
  it('rate=0 drops sampled levels, others pass', () => {
    const f = createSampler({ rate: 0, levels: ['info'] });
    expect(f(entry('info'))).toBe(false);
    expect(f(entry('error'))).toBe(true);
  });

  it('rate=1 keeps everything', () => {
    const f = createSampler({ rate: 1, levels: ['info'] });
    expect(f(entry('info'))).toBe(true);
    expect(f(entry('debug'))).toBe(true);
  });

  it('works without levels option (levelSet is undefined, all levels sampled)', () => {
    const f = createSampler({ rate: 0.5 });
    // With no levels option, levelSet is undefined so the first check is skipped
    // and all entries proceed to probabilistic sampling.
    const rnd = vi.spyOn(Math, 'random');
    rnd.mockReturnValue(0.3);
    expect(f(entry('info'))).toBe(true);
    expect(f(entry('error'))).toBe(true); // also sampled when no levelSet
    rnd.mockRestore();
  });

  it('works without maxPerSecond (capacity is 0)', () => {
    const f = createSampler({ rate: 1 });
    expect(f(entry('info'))).toBe(true);
    expect(f(entry('info'))).toBe(true);
  });

  it('covers maxPerSecond=undefined branch (capacity=0)', () => {
    // Line 50: `maxPerSecond !== undefined ? ... : 0` — branch false (undefined)
    const f = createSampler({ rate: 1, maxPerSecond: undefined as unknown as number });
    expect(f(entry('info'))).toBe(true);
  });

  it('probabilistic sampling is driven by Math.random', () => {
    const rnd = vi.spyOn(Math, 'random');
    const f = createSampler({ rate: 0.5, levels: ['info'] });
    rnd.mockReturnValue(0.3);
    expect(f(entry('info'))).toBe(true); // 0.3 < 0.5 → keep
    rnd.mockReturnValue(0.7);
    expect(f(entry('info'))).toBe(false); // 0.7 >= 0.5 → drop
    rnd.mockRestore();
  });

  it('rate limits with burst, refilling over time', () => {
    const f = createSampler({ levels: ['info'], maxPerSecond: 2, burst: 2 });
    expect(f(entry('info', 1000))).toBe(true);
    expect(f(entry('info', 1000))).toBe(true); // burst exhausted
    expect(f(entry('info', 1000))).toBe(false); // empty bucket
    expect(f(entry('info', 2000))).toBe(true); // +2 tokens after 1s
    expect(f(entry('info', 2000))).toBe(true);
    expect(f(entry('info', 2000))).toBe(false);
    expect(f(entry('info', 2500))).toBe(true); // +1 token after +0.5s
    expect(f(entry('info', 2500))).toBe(false);
  });

  it('never rate-limits levels outside the opt-in set', () => {
    const f = createSampler({ levels: ['info'], maxPerSecond: 1, burst: 1 });
    f(entry('info', 1000)); // consume the single token
    // 'error' is not sampled, so it always passes even with an empty bucket
    expect(f(entry('error', 1000))).toBe(true);
  });

  it('integrates as a pipeline filter (dropped entries never reach transports)', () => {
    const sink: LogEntry[] = [];
    const log = makeLogger();
    log.addTransport({
      name: 'cap',
      write: (e: LogEntry) => void sink.push(e),
    } as unknown as Transport);
    log.getPipeline().addFilter(createSampler({ rate: 0, levels: ['info', 'debug'] }));
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(sink.map((s) => s.levelName)).toEqual(['warn', 'error']);
  });
});
