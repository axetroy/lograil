import { describe, it, expect } from 'vitest';
import { Pipeline } from '../src/pipeline/index.js';
import { createLevelFilter, createScopeFilter } from '../src/pipeline/filter.js';
import { createRedactProcessor } from '../src/pipeline/processor.js';
import { createJsonFormatter } from '../src/pipeline/formatter.js';
import type { LogEntry } from '../src/types.js';
import { LOG_LEVELS } from '../src/types.js';

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    level: LOG_LEVELS.info,
    levelName: 'info',
    message: 'hello',
    args: [],
    timestamp: Date.now(),
    time: new Date().toISOString(),
    context: {},
    metadata: {},
    ...over,
  };
}

describe('Pipeline', () => {
  it('drops entries below the level filter', () => {
    const p = new Pipeline({ filters: [createLevelFilter(LOG_LEVELS.warn)] });
    expect(p.process(makeEntry({ level: LOG_LEVELS.info }))).toBeNull();
    expect(p.process(makeEntry({ level: LOG_LEVELS.error }))).not.toBeNull();
  });

  it('combines multiple filters', () => {
    const p = new Pipeline({
      filters: [createLevelFilter(LOG_LEVELS.info), createScopeFilter(['app'])],
    });
    expect(p.process(makeEntry({ scope: 'other' }))).toBeNull();
    expect(p.process(makeEntry({ scope: 'app' }))).not.toBeNull();
  });

  it('runs processors to redact sensitive data', () => {
    const p = new Pipeline({
      processors: [createRedactProcessor(['password'])],
    });
    const out = p.process(makeEntry({ context: { password: 'secret', user: 'bob' } }));
    expect(out!.context.password).toBe('[REDACTED]');
    expect(out!.context.user).toBe('bob');
  });

  it('formats entries to JSON', () => {
    const p = new Pipeline({ formatter: createJsonFormatter() });
    const out = p.process(makeEntry({ message: 'x' }))!;
    const json = p.getFormatter()(out);
    expect(JSON.parse(json).message).toBe('x');
  });
});
