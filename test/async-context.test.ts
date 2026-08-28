import { describe, it, expect } from 'vitest';
import type { LogEntry } from '../src/types.js';
import type { RuntimeAdapter } from '../src/runtime/index.js';
import type { Transport } from '../src/transport/transport.js';
import { Logger } from '../src/core/logger.js';
import { runWithContext, asyncContext } from '../src/context/async-context.js';

function captureLogger() {
  const entries: LogEntry[] = [];
  const transport: Transport = { name: 'cap', write: (e: LogEntry) => void entries.push(e) };
  const runtime = {
    name: 'node',
    now: () => 0,
    pid: () => 1,
    hasFileSystem: () => false,
    defaultTransports: () => [],
  } as unknown as RuntimeAdapter;
  const log = new Logger({ transports: [transport], level: 'debug', runtime });
  return { log, entries };
}

describe('Ambient async context', () => {
  it('is supported in this runtime', () => {
    expect(asyncContext.supported()).toBe(true);
  });

  it('attaches context set via runWithContext to entries', () => {
    const { log, entries } = captureLogger();
    runWithContext(() => log.info('hi'), { requestId: 'r1' });
    expect((entries[0].context as Record<string, unknown>).requestId).toBe('r1');
  });

  it('propagates across awaits', async () => {
    const { log, entries } = captureLogger();
    await runWithContext(
      async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 1));
        log.info('mid');
      },
      { requestId: 'r2' },
    );
    expect(entries).toHaveLength(1);
    expect((entries[0].context as Record<string, unknown>).requestId).toBe('r2');
  });

  it('nested runs override the outer scope only within their callback', () => {
    const { log, entries } = captureLogger();
    runWithContext(
      () => {
        log.info('outer');
        runWithContext(() => log.info('inner'), { requestId: 'inner' });
        log.info('outer2');
      },
      { requestId: 'outer' },
    );
    expect((entries[0].context as Record<string, unknown>).requestId).toBe('outer');
    expect((entries[1].context as Record<string, unknown>).requestId).toBe('inner');
    expect((entries[2].context as Record<string, unknown>).requestId).toBe('outer');
  });

  it('leaves context untouched when no ambient context is active', () => {
    const { log, entries } = captureLogger();
    log.info('plain');
    expect(entries[0].context).toEqual({});
  });

  it('ambient overrides logger-level context but merges otherwise', () => {
    const { log, entries } = captureLogger();
    log.setContext('service', 'auth');
    runWithContext(() => log.info('x'), { requestId: 'r' });
    expect((entries[0].context as Record<string, unknown>).service).toBe('auth');
    expect((entries[0].context as Record<string, unknown>).requestId).toBe('r');
  });
});
