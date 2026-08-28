import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '../src/core/logger.js';
import type { LogEntry } from '../src/types.js';
import type { RuntimeAdapter } from '../src/runtime/adapter.js';
import type { Transport } from '../src/transport/transport.js';

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

describe('redirectConsole', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
    vi.restoreAllMocks();
  });

  it('routes console.* through the logger and suppresses native output', () => {
    const { log, entries } = captureLogger();
    restore = log.redirectConsole();
    console.log('hello', { a: 1 });
    expect(entries).toHaveLength(1);
    expect(entries[0].levelName).toBe('info');
    expect(entries[0].message).toBe('hello');
  });

  it('maps console.error to the logger error level', () => {
    const { log, entries } = captureLogger();
    restore = log.redirectConsole();
    console.error(new Error('boom'));
    expect(entries).toHaveLength(1);
    expect(entries[0].levelName).toBe('error');
    expect((entries[0].error as Error).message).toBe('boom');
  });

  it('does not recurse (calls are safe in bulk)', () => {
    const { log, entries } = captureLogger();
    restore = log.redirectConsole();
    for (let i = 0; i < 200; i++) console.log(`m${i}`);
    expect(entries).toHaveLength(200);
  });

  it('restores the original console (stops routing) when the returned function is called', () => {
    const { log, entries } = captureLogger();
    restore = log.redirectConsole();
    console.log('routed');
    expect(entries).toHaveLength(1);
    restore();
    console.log('not-routed');
    expect(entries).toHaveLength(1); // unchanged after restore
  });
});

describe('attachExitHandlers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers beforeExit / SIGINT / SIGTERM handlers', () => {
    const on = vi.spyOn(process, 'on');
    const once = vi.spyOn(process, 'once');
    const { log } = captureLogger();
    log.attachExitHandlers();
    expect(on).toHaveBeenCalledWith('beforeExit', expect.any(Function));
    expect(once).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(once).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  it('is idempotent (second call does not re-register)', () => {
    const once = vi.spyOn(process, 'once');
    const { log } = captureLogger();
    log.attachExitHandlers();
    const afterFirst = (once as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    log.attachExitHandlers();
    const afterSecond = (once as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(afterSecond - afterFirst).toBe(0);
  });

  it('auto-registers when autoFlushOnExit is set', () => {
    const once = vi.spyOn(process, 'once');
    const runtime = {
      name: 'node',
      now: () => 0,
      pid: () => 1,
      hasFileSystem: () => false,
      defaultTransports: () => [],
    } as unknown as RuntimeAdapter;
    new Logger({ transports: [], level: 'debug', runtime, autoFlushOnExit: true });
    expect(once).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });
});

describe('watchUncaughtErrors', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers uncaughtException / unhandledRejection handlers', () => {
    const on = vi.spyOn(process, 'on');
    const { log } = captureLogger();
    log.watchUncaughtErrors();
    expect(on).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(on).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
  });

  it('logs a simulated uncaughtException at fatal level and exits', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const { log, entries } = captureLogger();
    log.watchUncaughtErrors();
    process.emit('uncaughtException', new Error('kaboom'));
    await new Promise((r) => setTimeout(r, 10));
    expect(
      entries.some((e) => e.levelName === 'fatal' && (e.error as Error)?.message === 'kaboom'),
    ).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
