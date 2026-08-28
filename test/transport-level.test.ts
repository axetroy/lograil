import { describe, it, expect } from 'vitest';
import { Logger } from '../src/core/logger.js';
import { LOG_LEVELS } from '../src/types.js';
import type { LogEntry, LogLevelInput } from '../src/types.js';
import type { RuntimeAdapter } from '../src/runtime/adapter.js';
import type { Transport } from '../src/transport/transport.js';

function makeCapture(name: string, level?: LogLevelInput) {
  const entries: LogEntry[] = [];
  const transport: Transport = {
    name,
    level,
    write: (e: LogEntry) => void entries.push(e),
  };
  return { transport, entries };
}

function makeLogger(transports: Transport[], level: LogLevelInput = 'trace') {
  const runtime = {
    name: 'node',
    now: () => 0,
    pid: () => 1,
    hasFileSystem: () => false,
    defaultTransports: () => [],
  } as unknown as RuntimeAdapter;
  return new Logger({ transports, level, runtime });
}

describe('per-transport level', () => {
  it('skips entries below a transport minimum level', () => {
    const errors = makeCapture('errs', 'error');
    const all = makeCapture('all');
    const log = makeLogger([errors.transport, all.transport]);

    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');

    expect(all.entries.map((e) => e.levelName)).toEqual(['info', 'warn', 'error', 'fatal']);
    expect(errors.entries.map((e) => e.levelName)).toEqual(['error', 'fatal']);
  });

  it('honors a numeric transport level', () => {
    const warn = makeCapture('warn', LOG_LEVELS.warn);
    const log = makeLogger([warn.transport]);
    log.debug('d');
    log.info('i');
    log.warn('w');
    expect(warn.entries.map((e) => e.levelName)).toEqual(['warn']);
  });

  it('routes everything when no transport level is set', () => {
    const sink = makeCapture('sink');
    const log = makeLogger([sink.transport]);
    log.trace('t');
    log.debug('d');
    log.info('i');
    expect(sink.entries).toHaveLength(3);
  });

  it('still respects the logger-level filter first', () => {
    const sink = makeCapture('sink', 'trace');
    const log = makeLogger([sink.transport], 'warn');
    log.info('blocked');
    log.error('kept');
    expect(sink.entries.map((e) => e.levelName)).toEqual(['error']);
  });
});
