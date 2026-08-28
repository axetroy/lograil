import { describe, it, expect } from 'vitest';
import { Logger } from '../src/core/index.js';
import type { LogEntry } from '../src/types.js';
import type { Transport } from '../src/transport/transport.js';
import { createLineFormatter, createJsonFormatter } from '../src/pipeline/formatter.js';

class Capture implements Transport {
  readonly name = 'capture';
  entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

async function logged(fn: (log: Logger) => void): Promise<LogEntry[]> {
  const cap = new Capture();
  const log = new Logger({ transports: [cap], level: 'debug' });
  fn(log);
  await log.flush();
  return cap.entries;
}

describe('LogFn signature & object logging', () => {
  it('preserves an object passed as the only argument (no [object Object])', async () => {
    const [e] = await logged((log) => log.info({ user: { id: 1 } }));
    expect(e.message).toBe('');
    expect(e.args).toEqual([{ user: { id: 1 } }]);
  });

  it('keeps a string message when the first arg is a string', async () => {
    const [e] = await logged((log) => log.info('hello', { a: 1 }));
    expect(e.message).toBe('hello');
    expect(e.args).toEqual([{ a: 1 }]);
  });

  it('supports a bare number / primitive as the first argument', async () => {
    const [e] = await logged((log) => log.info(42));
    expect(e.message).toBe('');
    expect(e.args).toEqual([42]);
  });

  it('extracts an Error passed as the first argument', async () => {
    const err = new Error('boom');
    const [e] = await logged((log) => log.error(err));
    expect(e.error).toBe(err);
    expect(e.message).toBe('boom');
  });

  it('extracts an Error from trailing arguments', async () => {
    const err = new Error('boom');
    const [e] = await logged((log) => log.error('failed', err));
    expect(e.error).toBe(err);
    expect(e.message).toBe('failed');
  });

  it('serializes objects in the line formatter output', async () => {
    const [e] = await logged((log) => log.info({ user: { id: 1 } }));
    const line = createLineFormatter()(e);
    expect(line).toContain('INFO');
    expect(line).toContain('"user"');
    expect(line).toContain('"id"');
  });

  it('serializes objects in the json formatter output', async () => {
    const [e] = await logged((log) => log.info({ user: { id: 1 } }));
    const json = JSON.parse(createJsonFormatter()(e));
    expect(json.args).toEqual([{ user: { id: 1 } }]);
  });
});
