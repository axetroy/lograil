import { describe, it, expect } from 'vitest';
import { Logger } from '../src/core/index.js';
import type { LogEntry } from '../src/types.js';
import type { Transport } from '../src/transport/transport.js';
import { createLineFormatter } from '../src/pipeline/formatter.js';

class MemoryTransport implements Transport {
  readonly name = 'memory';
  entries: LogEntry[] = [];
  lines: string[] = [];
  formatter = createLineFormatter();

  write(entry: LogEntry, formatted: string): void {
    this.entries.push(entry);
    this.lines.push(formatted);
  }
}

describe('Logger', () => {
  it('emits entries to transports', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });
    logger.info('hello', { a: 1 });
    logger.debug('dbg');
    await logger.flush();

    expect(t.entries).toHaveLength(2);
    expect(t.entries[0].message).toBe('hello');
    expect(t.entries[0].context).toEqual({});
    expect(t.lines[0]).toContain('INFO');
  });

  it('respects the configured level', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'warn' });
    logger.info('skipped');
    logger.error('shown');
    await logger.flush();

    expect(t.entries).toHaveLength(1);
    expect(t.entries[0].levelName).toBe('error');
  });

  it('attaches errors passed as the message', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });
    const err = new Error('boom');
    logger.error(err);
    await logger.flush();

    expect(t.entries[0].error).toBe(err);
    expect(t.entries[0].message).toBe('boom');
  });

  it('supports child loggers with scoped context', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });
    const child = logger.scope('sub', { requestId: 'r1' });
    child.info('hi');
    await logger.flush();

    expect(t.entries[0].scope).toBe('sub');
    expect(t.entries[0].context).toEqual({ requestId: 'r1' });
  });

  it('removes transports by name', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });
    logger.removeTransport('memory');
    logger.info('gone');
    await logger.flush();
    expect(t.entries).toHaveLength(0);
  });
});
