import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Logger } from '../src/core/index.js';
import { Pipeline } from '../src/pipeline/pipeline.js';
import { createRedactProcessor } from '../src/pipeline/processor.js';
import type { LogEntry } from '../src/types.js';
import type { Plugin } from '../src/plugin/index.js';
import { PluginManager } from '../src/plugin/index.js';
import type { RuntimeAdapter } from '../src/runtime/index.js';
import type { Transport } from '../src/transport/transport.js';
import { createLineFormatter } from '../src/pipeline/formatter.js';
import { FileTransport } from '../src/transport/file.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class MemoryTransport implements Transport {
  readonly name: string;
  entries: LogEntry[] = [];
  formatter = createLineFormatter();
  added = false;
  closed = false;
  constructor(name = 'memory') {
    this.name = name;
  }
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
  close(): void {
    this.closed = true;
  }
}

function makeRuntime(): RuntimeAdapter {
  return {
    name: 'web',
    now: () => 1_000,
    pid: () => 7,
    hasFileSystem: () => false,
    defaultTransports: () => [],
  };
}

describe('Logger - level & context', () => {
  it('setLevel changes filtering at runtime', async () => {
    const t = new MemoryTransport();
    const log = new Logger({ transports: [t], level: 'error', runtime: makeRuntime() });
    log.info('no');
    log.setLevel('debug');
    log.info('yes');
    await log.flush();
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0].message).toBe('yes');
  });

  it('carries context set on the logger', async () => {
    const t = new MemoryTransport();
    const log = new Logger({ transports: [t], level: 'debug', runtime: makeRuntime() });
    log.setContext('env', 'prod');
    log.mergeContext({ region: 'eu' });
    log.info('hi');
    await log.flush();
    expect(t.entries[0].context).toEqual({ env: 'prod', region: 'eu' });
  });

  it('does not leak child context into the parent', async () => {
    const t = new MemoryTransport();
    const log = new Logger({ transports: [t], level: 'debug', runtime: makeRuntime() });
    const child = log.scope('c', { k: 'v' });
    child.info('x');
    await log.flush();
    expect(t.entries[0].context).toEqual({ k: 'v' });
  });
});

describe('Logger - pipeline control', () => {
  it('runs formatter exceptions without throwing', async () => {
    const errors: string[] = [];
    const broken: Transport = {
      name: 'broken',
      formatter: () => {
        throw new Error('boom');
      },
      write() {},
    };
    const log = new Logger({
      transports: [broken],
      level: 'debug',
      runtime: makeRuntime(),
      onError: (_err, info) => errors.push(info.phase),
    });
    log.info('safe');
    await log.flush();
    expect(errors).toEqual(['formatter']);
  });

  it('adds filters and processors dynamically', async () => {
    const t = new MemoryTransport();
    const pipeline = new Pipeline();
    pipeline.setFormatter(createLineFormatter());
    pipeline.addFilter((e) => e.levelName !== 'debug');
    const log = new Logger({
      transports: [t],
      level: 'debug',
      runtime: makeRuntime(),
      pipeline,
    });
    log.debug('dropped');
    log.info('kept');
    await log.flush();
    expect(t.entries.map((e) => e.message)).toEqual(['kept']);
  });
});

describe('Pipeline - add/remove', () => {
  it('addProcessor enriches and removeProcessor/removeFilter revert', async () => {
    const t = new MemoryTransport();
    const pipeline = new Pipeline();
    pipeline.setFormatter(createLineFormatter());
    const tagger = (e: LogEntry): LogEntry => ({ ...e, metadata: { ...e.metadata, tagged: true } });
    pipeline.addProcessor(tagger);
    const log = new Logger({ transports: [t], level: 'debug', runtime: makeRuntime(), pipeline });
    log.info('a');
    await log.flush();
    expect(t.entries[0].metadata).toEqual({ tagged: true });

    pipeline.removeProcessor(tagger);
    log.info('b');
    await log.flush();
    expect(t.entries[1].metadata).toEqual({});

    const dropDebug = (e: LogEntry) => e.levelName !== 'debug';
    pipeline.addFilter(dropDebug);
    log.debug('c');
    await log.flush();
    expect(t.entries).toHaveLength(2);
    pipeline.removeFilter(dropDebug);
  });
});

describe('Processor - redact', () => {
  it('redacts nested objects recursively', () => {
    const redact = createRedactProcessor(['password']);
    const entry = {
      level: 30,
      levelName: 'info' as const,
      message: 'm',
      args: [],
      timestamp: 0,
      time: '',
      context: { user: 'alice', password: 'secret', nested: { password: 'x', ok: 1 } },
      metadata: {},
    } as unknown as LogEntry;
    const out = redact(entry);
    expect((out.context as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((out.context as Record<string, unknown>).user).toBe('alice');
    expect(
      ((out.context as Record<string, unknown>).nested as Record<string, unknown>).password,
    ).toBe('[REDACTED]');
    expect(((out.context as Record<string, unknown>).nested as Record<string, unknown>).ok).toBe(1);
  });
});

describe('Logger - async transport (RotatingFile)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elog-async-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('awaits the transport write queue, flush and close via destroy', async () => {
    const file = join(dir, 'app.log');
    const transport = new FileTransport({ mode: 'single', appName: 'app', dir, ext: 'log' });
    const log = new Logger({ transports: [transport], level: 'debug', runtime: makeRuntime() });
    log.info('one');
    log.info('two');
    await log.flush();
    const content = (await readFile(file, 'utf8')).trim();
    expect(content.split('\n')).toHaveLength(2);
    expect(content).toContain('one');
    expect(content).toContain('two');

    // destroy() should close the underlying transport without throwing.
    await expect(log.destroy()).resolves.toBeUndefined();
    // After destroy, emitting is a no-op (does not throw).
    log.info('ignored');
  });
});

describe('Logger - lifecycle', () => {
  it('destroy closes transports and stops emitting', async () => {
    const t = new MemoryTransport();
    const log = new Logger({ transports: [t], level: 'debug', runtime: makeRuntime() });
    log.info('before');
    await log.destroy();
    log.info('after');
    expect(t.entries).toHaveLength(1);
    expect(t.closed).toBe(true);
  });

  it('removeTransport flushes and closes removed transports', async () => {
    const calls: string[] = [];
    const transport: Transport = {
      name: 'tmp',
      write: () => {},
      flush: async () => {
        calls.push('flush');
      },
      close: async () => {
        calls.push('close');
      },
    };
    const log = new Logger({ transports: [transport], level: 'debug', runtime: makeRuntime() });
    log.info('before-remove');
    log.removeTransport('tmp');
    await log.flush();

    expect(calls).toEqual(['flush', 'close']);
    expect(log.getTransports()).toHaveLength(0);
  });
});

describe('PluginManager', () => {
  function makeHost(added: string[]) {
    const manager = new PluginManager({
      addTransport: (t) => {
        added.push(`added:${t.name}`);
        manager.notifyTransport(t);
      },
      removeTransport: () => {},
      pipeline: new Pipeline(),
      use: async () => {},
      unregisterPlugin: () => {},
      logger: {} as Logger,
    });
    return manager;
  }

  it('notifies onTransport and supports unregister', async () => {
    const added: string[] = [];
    const manager = makeHost(added);
    const p1: Plugin = {
      name: 'p1',
      onTransport: (t) => added.push(`seen:${t.name}`),
    };
    const p2: Plugin = {
      name: 'p2',
      onInit(ctx) {
        ctx.addTransport({ name: 'xt' } as Transport);
      },
    };
    await manager.register(p1);
    await manager.register(p2);
    expect(added).toContain('added:xt');
    expect(added).toContain('seen:xt');
    manager.unregister('p1');
    expect(manager.has('p1')).toBe(false);
  });

  it('calls onDestroy on destroy', async () => {
    const destroyed: string[] = [];
    const manager = makeHost(destroyed);
    await manager.register({
      name: 'd',
      onDestroy: () => {
        destroyed.push('d');
      },
    });
    await manager.destroy();
    expect(destroyed).toEqual(['d']);
  });
});

describe('Plugin adds a transport', () => {
  it('a plugin can register a transport during onInit', async () => {
    const main = new MemoryTransport('main');
    const extra = new MemoryTransport('extra');
    const adder: Plugin = {
      name: 'adder',
      onInit(ctx) {
        ctx.addTransport(extra);
      },
    };
    const log = new Logger({
      transports: [main],
      level: 'debug',
      runtime: makeRuntime(),
    });
    await log.use(adder);
    log.info('hello');
    await log.flush();
    expect(main.entries).toHaveLength(1);
    expect(extra.entries).toHaveLength(1);
  });
});
