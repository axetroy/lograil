import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Logger } from '../src/core/index.js';
import { Pipeline } from '../src/pipeline/pipeline.js';
import {
  createRedactProcessor,
  DEFAULT_SENSITIVE_KEYS_SNAKE,
  DEFAULT_SENSITIVE_KEYS_KEBAB,
} from '../src/pipeline/processor.js';
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

describe('Logger - secure mode', () => {
  it('injects a redact processor when secure is true', () => {
    const log = new Logger({ level: 'debug', secure: true, transports: [] });
    const pipeline = log.getPipeline();
    // the redact processor must be present
    const entry = {
      level: 30,
      levelName: 'info' as const,
      message: 'test',
      args: [{ password: 'secret123', token: 'abc' }],
      timestamp: 1,
      time: new Date(1).toISOString(),
      context: {},
      metadata: {},
    };
    const out = pipeline.process(entry);
    expect(out).not.toBeNull();
    const args = (out!.args as unknown[])[0] as Record<string, unknown>;
    expect(args.password).toBe('[REDACTED]');
    expect(args.token).toBe('[REDACTED]');
  });

  it('does not inject redact processor when secure is explicitly false', () => {
    const log = new Logger({ level: 'debug', secure: false, transports: [] });
    const pipeline = log.getPipeline();
    const entry = {
      level: 30,
      levelName: 'info' as const,
      message: 'test',
      args: [{ password: 'secret123' }],
      timestamp: 1,
      time: new Date(1).toISOString(),
      context: {},
      metadata: {},
    };
    const out = pipeline.process(entry);
    expect(out).not.toBeNull();
    const args = (out!.args as unknown[])[0] as Record<string, unknown>;
    // explicit secure: false → no redaction
    expect(args.password).toBe('secret123');
  });

  it('adds the redact processor after existing pipeline processors', () => {
    let customCalled = false;
    const log = new Logger({
      level: 'debug',
      secure: true,
      pipeline: {
        processors: [
          (entry) => {
            customCalled = true;
            return entry;
          },
        ],
      },
      transports: [],
    });
    const pipeline = log.getPipeline();
    const entry = {
      level: 30,
      levelName: 'info' as const,
      message: 'test',
      args: [{ password: 'x' }],
      timestamp: 1,
      time: new Date(1).toISOString(),
      context: {},
      metadata: {},
    };
    pipeline.process(entry);
    expect(customCalled).toBe(true);
    const out = pipeline.process(entry);
    expect((out!.args as unknown[])[0]).toEqual({ password: '[REDACTED]' });
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

describe('DEFAULT_SENSITIVE_KEYS conversion', () => {
  it('snake_case variant matches common JS/JSON snake keys', () => {
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('access_token');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('refresh_token');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('api_key');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('private_key');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('session_id');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('csrf_token');
    // new entries
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('app_key');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('app_secret');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('client_key');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('client_secret');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('secret_key');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('webhook_secret');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('private_key_value');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('publishable_key');
    // header-style flat names stay flat
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('x_api_key');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('x_api_token');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('x_auth');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('x_forwarded_for');
    // flat words stay flat
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('auth');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('authorization');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('password');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('token');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('secret');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('bearer');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('cookie');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('otp');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('ssn');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('cvv');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('pin');
    expect(DEFAULT_SENSITIVE_KEYS_SNAKE).toContain('signature');
  });

  it('kebab-case variant matches common HTTP header / CSS style keys', () => {
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('x-api-key');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('set-cookie');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('access-token');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('refresh-token');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('api-key');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('private-key');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('session-id');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('csrf-token');
    // new entries
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('app-key');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('app-secret');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('client-key');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('client-secret');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('secret-key');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('webhook-secret');
    // 'private_key_value' is already snake — conversion is a no-op, stays as-is
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('private_key_value');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('publishable-key');
    // header-style flat names stay flat
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('x-api-key');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('x-api-token');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('x-auth');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('x-forwarded-for');
    // flat words stay flat
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('auth');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('authorization');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('password');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('token');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('secret');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('bearer');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('cookie');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('otp');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('ssn');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('cvv');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('pin');
    expect(DEFAULT_SENSITIVE_KEYS_KEBAB).toContain('signature');
  });

  it('generated snake/kebab lists are consumed correctly by createRedactProcessor', () => {
    // snake_case list should redact snake_case keys
    const snakeEntry = {
      level: 30,
      levelName: 'info' as const,
      message: 'test',
      args: [{ access_token: 'tok1', x_api_key: 'key1' }],
      timestamp: 1,
      time: new Date(1).toISOString(),
      context: {},
      metadata: {},
    };
    const snakeOut = createRedactProcessor(DEFAULT_SENSITIVE_KEYS_SNAKE)(snakeEntry);
    expect(snakeOut!.args[0]).toEqual({ access_token: '[REDACTED]', x_api_key: '[REDACTED]' });

    // kebab-case list should redact kebab-case keys
    const kebabEntry = {
      level: 30,
      levelName: 'info' as const,
      message: 'test',
      args: [{ 'access-token': 'tok2', 'x-api-key': 'key2' }],
      timestamp: 1,
      time: new Date(1).toISOString(),
      context: {},
      metadata: {},
    };
    const kebabOut = createRedactProcessor(DEFAULT_SENSITIVE_KEYS_KEBAB)(kebabEntry);
    expect(kebabOut!.args[0]).toEqual({ 'access-token': '[REDACTED]', 'x-api-key': '[REDACTED]' });
  });
});
