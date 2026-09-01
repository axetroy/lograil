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

  it('getLevel reflects the peer level set by a cross-process command', async () => {
    const t = new MemoryTransport();
    // Simulate a runtime that has attachReceiver and calls onLevelCommand.
    const runtime = {
      name: 'node' as const,
      now: () => 0,
      pid: () => undefined,
      hasFileSystem: () => false,
      defaultTransports: () => [t],
      attachReceiver: () => () => {},
    } as unknown as Logger['runtime'];
    const logger = new Logger({ transports: [t], level: 'info', runtime });
    expect(logger.getLevel()).toBe(30); // info
    // Simulate a peer setting the level to debug (20) via onLevelCommand.
    runtime.onLevelCommand!(20);
    expect(logger.getLevel()).toBe(20); // debug
    // Local setLevel still wins (levelOverride takes precedence).
    logger.setLevel('warn');
    expect(logger.getLevel()).toBe(40);
  });

  it('getLevel falls back to local level when no peer has sent a command', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'warn' });
    expect(logger.getLevel()).toBe(40);
  });

  it('peerLevel is cleared on destroy', async () => {
    const t = new MemoryTransport();
    // Simulate a runtime that has attachReceiver and calls onLevelCommand.
    const runtime = {
      name: 'node' as const,
      now: () => 0,
      pid: () => undefined,
      hasFileSystem: () => false,
      defaultTransports: () => [t],
      attachReceiver: () => () => {},
    } as unknown as Logger['runtime'];
    const logger = new Logger({ transports: [t], level: 'info', runtime });
    // Simulate a peer setting the level to debug (20) via onLevelCommand.
    runtime.onLevelCommand!(20);
    expect(logger.getLevel()).toBe(20);
    await logger.destroy();
    // After destroy, getLevel should fall back to the original local level.
    expect(logger.getLevel()).toBe(30);
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

  it('scope() without extra context still derives a scoped child', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });
    const child = logger.scope('svc');
    child.info('hi');
    await logger.flush();
    expect(t.entries[0].scope).toBe('svc');
    expect(t.entries[0].context).toEqual({});
  });

  it('setLevel accepts a numeric level', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'info' });
    logger.setLevel(50); // error
    logger.info('skipped');
    logger.error('shown');
    await logger.flush();
    expect(t.entries.map((e) => e.levelName)).toEqual(['error']);
  });

  it('redirectConsole routes console.* through the logger and restores', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });
    const restore = logger.redirectConsole();
    console.info('via-console');
    restore();
    console.info('after-restore');
    await logger.flush();
    // Only the redirected call reaches the transport; the restored one does not.
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0].message).toBe('via-console');
  });

  it('does not emit after destroy()', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });
    await logger.destroy();
    logger.info('after destroy');
    await logger.flush();
    expect(t.entries).toHaveLength(0);
  });
});
