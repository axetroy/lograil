import { describe, it, expect, vi } from 'vitest';
import { Logger } from '../src/core/logger.js';
import type { LogEntry } from '../src/types.js';
import type { RuntimeAdapter } from '../src/runtime/adapter.js';
import type { Transport } from '../src/transport/transport.js';

function makeLogger(transport: Transport) {
  const runtime = {
    name: 'node',
    now: () => 0,
    pid: () => 1,
    hasFileSystem: () => false,
    defaultTransports: () => [],
  } as unknown as RuntimeAdapter;
  return new Logger({ transports: [transport], level: 'trace', runtime });
}

describe('Transport onError hook', () => {
  it('invokes onError (not the caller) when a synchronous write throws', () => {
    const onError = vi.fn();
    const transport: Transport = {
      name: 'boom',
      onError,
      write: () => {
        throw new Error('disk full');
      },
    };
    const log = makeLogger(transport);
    expect(() => log.info('hi')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0][0] as Error).message)).toBe('disk full');
    expect((onError.mock.calls[0][1] as LogEntry).message).toBe('hi');
  });

  it('invokes onError when an async write rejects', async () => {
    const onError = vi.fn();
    const transport: Transport = {
      name: 'async-boom',
      onError,
      write: () => Promise.reject(new Error('network')),
    };
    const log = makeLogger(transport);
    log.info('hi');
    await new Promise((r) => setTimeout(r, 10));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0][0] as Error).message)).toBe('network');
  });

  it('does not break other transports when one fails', async () => {
    const errors: unknown[] = [];
    const good: LogEntry[] = [];
    const bad: Transport = {
      name: 'bad',
      onError: (e) => void errors.push(e),
      write: () => Promise.reject(new Error('x')),
    };
    const ok: Transport = { name: 'ok', write: (e: LogEntry) => void good.push(e) };
    const log = makeLogger(bad);
    log.addTransport(ok);
    log.info('hello');
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toHaveLength(1);
    expect(good).toHaveLength(1);
  });
});
