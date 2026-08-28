import { describe, it, expect } from 'vitest';
import { Logger } from '../src/core/logger.js';
import type { LogEntry } from '../src/types.js';
import type { RuntimeAdapter } from '../src/runtime/adapter.js';
import type { Transport } from '../src/transport/transport.js';

function capturingTransport(name: string, sink: LogEntry[]) {
  return {
    name,
    write: (e: LogEntry) => void sink.push(e),
  } as unknown as Transport;
}

function makeLogger(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' = 'info') {
  const runtime = {
    name: 'node',
    now: () => 0,
    pid: () => 1,
    hasFileSystem: () => false,
    defaultTransports: () => [],
  } as unknown as RuntimeAdapter;
  return new Logger({ level, runtime });
}

describe('Logger.child', () => {
  it('shares the parent transports and merges context at creation', () => {
    const sink: LogEntry[] = [];
    const log = makeLogger();
    log.addTransport(capturingTransport('cap', sink));
    log.mergeContext({ app: 'api' });
    const child = log.child({ context: { requestId: 'r1' } });
    child.info('handled');
    expect(sink).toHaveLength(1);
    expect(sink[0].context).toMatchObject({ app: 'api', requestId: 'r1' });
  });

  it('does not let the child mutate the parent context', () => {
    const sink: LogEntry[] = [];
    const log = makeLogger();
    log.addTransport(capturingTransport('cap', sink));
    log.mergeContext({ app: 'api' });
    const child = log.child({ context: { requestId: 'r1' } });
    child.setContext('app', 'hacked');
    log.info('parent');
    child.info('child');
    const parentEntry = sink.find((e) => e.message === 'parent')!;
    const childEntry = sink.find((e) => e.message === 'child')!;
    expect(parentEntry.context.app).toBe('api');
    expect(childEntry.context.app).toBe('hacked');
    expect(childEntry.context.requestId).toBe('r1');
  });

  it('honors a per-child level override', () => {
    const sink: LogEntry[] = [];
    const log = makeLogger('info');
    log.addTransport(capturingTransport('cap', sink));
    const child = log.child({ level: 'error' });
    child.info('dropped');
    child.error('kept');
    expect(sink.map((e) => e.levelName)).toEqual(['error']);
  });

  it('inherits the parent level live when no override is set', () => {
    const sink: LogEntry[] = [];
    const log = makeLogger('warn');
    log.addTransport(capturingTransport('cap', sink));
    const child = log.child();
    child.info('dropped-while-warn');
    log.setLevel('debug');
    child.debug('now-visible');
    expect(sink.map((e) => e.levelName)).toEqual(['debug']);
  });

  it('lets setLevel on the child act as an override', () => {
    const sink: LogEntry[] = [];
    const log = makeLogger('warn');
    log.addTransport(capturingTransport('cap', sink));
    const child = log.child();
    child.setLevel('error');
    log.setLevel('debug');
    child.info('still-dropped');
    child.error('kept');
    expect(sink.map((e) => e.levelName)).toEqual(['error']);
  });

  it('nests: grandchild merges ancestor contexts and inherits level', () => {
    const sink: LogEntry[] = [];
    const log = makeLogger('info');
    log.addTransport(capturingTransport('cap', sink));
    log.mergeContext({ app: 'api' });
    const child = log.child({ context: { tenant: 'acme' } });
    const grand = child.child({ context: { userId: 'u7' } });
    grand.info('nested');
    expect(sink[0].context).toMatchObject({ app: 'api', tenant: 'acme', userId: 'u7' });
  });

  it('inherits the parent scope', () => {
    const sink: LogEntry[] = [];
    const log = makeLogger();
    log.addTransport(capturingTransport('cap', sink));
    const scoped = log.scope('svc');
    const child = scoped.child();
    child.info('hi');
    expect(sink[0].scope).toBe('svc');
  });
});
