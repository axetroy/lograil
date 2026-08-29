import { describe, it, expect, vi } from 'vitest';
import { Logger } from '../src/core/logger.js';
import { createSerializeProcessor } from '../src/pipeline/processor.js';
import type { LogEntry } from '../src/types.js';
import type { RuntimeAdapter } from '../src/runtime/adapter.js';
import type { Transport } from '../src/transport/transport.js';

function captureLogger(processors: Parameters<typeof createSerializeProcessor>[0]) {
  const entries: LogEntry[] = [];
  const transport: Transport = { name: 'cap', write: (e: LogEntry) => void entries.push(e) };
  const runtime = {
    name: 'node',
    now: () => 0,
    pid: () => 1,
    hasFileSystem: () => false,
    defaultTransports: () => [],
  } as unknown as RuntimeAdapter;
  const log = new Logger({
    transports: [transport],
    level: 'trace',
    runtime,
    pipeline: { processors: [createSerializeProcessor(processors)] },
  });
  return { log, entries };
}

describe('createSerializeProcessor', () => {
  it('replaces values by key name in context, metadata and args', () => {
    const { log, entries } = captureLogger({
      user: (u: unknown) => ({ id: (u as { id: number }).id }),
    });
    log.mergeContext({ user: { id: 7, password: 'x' } });
    log.info('hi', { user: { id: 9, token: 't' } });

    const entry = entries[0];
    expect(entry.context.user).toEqual({ id: 7 });
    expect((entry.args[0] as { user: { id: number } }).user).toEqual({ id: 9 });
  });

  it('applies at any depth', () => {
    const { log, entries } = captureLogger({
      email: (e: unknown) => String(e).toLowerCase(),
    });
    log.info('x', { nested: { email: 'Foo@Bar.COM' } });
    expect((entries[0].args[0] as { nested: { email: string } }).nested.email).toBe('foo@bar.com');
  });

  it('runs the error serializer on entry.error', () => {
    const ser = vi.fn((e: unknown) => ({ name: (e as Error).name }));
    const { log, entries } = captureLogger({ error: ser });
    log.error(new Error('boom'));
    expect(ser).toHaveBeenCalled();
    expect((entries[0].error as { name: string }).name).toBe('Error');
  });

  it('passes the entry for contextual serialization', () => {
    const { log, entries } = captureLogger({
      level: (_v, entry) => entry.levelName,
    });
    log.info('x', { level: 'PLACEHOLDER' });
    expect((entries[0].args[0] as { level: string }).level).toBe('info');
  });

  it('adds no allocation when no serializer matches', () => {
    const ser = vi.fn((v: unknown) => v);
    const { log, entries } = captureLogger({ secret: ser });
    const ref = { a: 1 };
    log.info('plain', ref);
    expect(ser).not.toHaveBeenCalled();
    expect(entries[0].args[0]).toBe(ref); // unchanged reference
  });

  it('serializes matching keys inside context and args', () => {
    const { log, entries } = captureLogger({
      user: (u: unknown) => ({ id: (u as { id: number }).id }),
    });
    log.mergeContext({ user: { id: 1, pw: 'x' } });
    log.info('hi', { user: { id: 2, pw: 'y' } });
    expect((entries[0].context as { user: { id: number } }).user).toEqual({ id: 1 });
    expect((entries[0].args[0] as { user: { id: number } }).user).toEqual({ id: 2 });
  });

  it('runs the error serializer and replaces entry.error', () => {
    const ser = vi.fn((e: unknown) => ({ name: (e as Error).name }));
    const { log, entries } = captureLogger({ error: ser });
    const err = new Error('boom');
    log.error(err); // 'error' key matches the serializer
    expect(ser).toHaveBeenCalled();
    expect((entries[0].error as { name: string }).name).toBe('Error');
  });

  it('returns identity when given an empty serializer map', () => {
    const { log, entries } = captureLogger({});
    const ref = { a: 1 };
    log.info('plain', ref);
    expect(entries[0].args[0]).toBe(ref);
  });
});
