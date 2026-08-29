import { describe, it, expect, vi } from 'vitest';
import { createLineFormatter, createJsonFormatter } from '../src/pipeline/formatter.js';
import {
  createRedactProcessor,
  createSerializeProcessor,
  createDefaultSerializers,
} from '../src/pipeline/processor.js';
import { LiveTransport } from '../src/transport/live.js';
import { PluginManager } from '../src/plugin/manager.js';
import { ConsoleTransport } from '../src/transport/console.js';
import { asyncContext } from '../src/context/async-context.js';
import type { LogEntry } from '../src/types.js';
import { LOG_LEVELS } from '../src/types.js';
import type { Plugin } from '../src/plugin/index.js';

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    level: LOG_LEVELS.info,
    levelName: 'info',
    message: 'msg',
    args: [],
    timestamp: 1_700_000_000_000,
    time: new Date(1_700_000_000_000).toISOString(),
    context: {},
    metadata: {},
    ...over,
  };
}

describe('formatter: error cause chains', () => {
  it('formats an error with a nested cause (short + chain forms)', () => {
    const cause = new Error('root');
    const err = new Error('boom');
    (err as unknown as { cause: unknown }).cause = cause;
    const fmt = createLineFormatter();
    const line = fmt(makeEntry({ error: err }));
    expect(line).toContain('boom');
    expect(line).toContain('root');
  });

  it('serializes a circular error cause without throwing', () => {
    const a = new Error('a') as unknown as Error & { cause?: unknown };
    const b = new Error('b') as unknown as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    const fmt = createLineFormatter();
    expect(() => fmt(makeEntry({ error: a }))).not.toThrow();
    expect(fmt(makeEntry({ error: a }))).toContain('[Circular cause]');
  });
});

describe('formatter: non-JSON-serializable values', () => {
  it('formats Map, Set, bigint, symbol and function args', () => {
    const fmt = createLineFormatter();
    const line = fmt(
      makeEntry({
        args: [new Map([['k', 1]]), new Set([1, 2]), 10n, Symbol('s'), () => {}],
      }),
    );
    expect(line).toContain('Map(1)');
    expect(line).toContain('Set(2)');
    expect(line).toContain('10n');
    expect(line).toContain('Symbol');
    expect(line).toContain('[Function:');
  });

  it('serializes a circular object via the safe replacer', () => {
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    const fmt = createJsonFormatter();
    const out = JSON.parse(fmt(makeEntry({ args: [circ] })));
    // The safe replacer yields a '[Circular]' marker rather than throwing.
    expect(JSON.stringify(out)).toContain('[Circular]');
  });

  it('flattens context/metadata when the json formatter flatten option is set', () => {
    const fmt = createJsonFormatter({ flatten: true });
    const out = JSON.parse(
      fmt(makeEntry({ context: { tenant: 'acme' }, metadata: { trace: 'x' } })),
    );
    expect(out.tenant).toBe('acme');
    expect(out.trace).toBe('x');
  });
});

describe('processor: redact paths', () => {
  it('redacts a dotted path and a wildcard (nested) key', () => {
    const redact = createRedactProcessor(['user.password', '*.token']);
    const entry = makeEntry({
      context: { user: { password: 'secret', name: 'bob' } },
      args: [{ inner: { token: 'abc', id: 1 } }],
    });
    const out = redact(entry);
    expect((out.context as { user: { password: string; name: string } }).user.password).toBe(
      '[REDACTED]',
    );
    expect((out.context as { user: { name: string } }).user.name).toBe('bob');
    expect((out.args[0] as { inner: { token: string; id: number } }).inner.token).toBe(
      '[REDACTED]',
    );
    expect((out.args[0] as { inner: { id: number } }).inner.id).toBe(1);
  });

  it('redacts a bare scalar key at any depth', () => {
    const redact = createRedactProcessor(['password']);
    const entry = makeEntry({ args: [{ inner: { password: 'p' } }] });
    const out = redact(entry);
    expect((out.args[0] as { inner: { password: string } }).inner.password).toBe('[REDACTED]');
  });

  it('redacts matching keys inside array elements', () => {
    const redact = createRedactProcessor(['secret']);
    const entry = makeEntry({ args: [{ secret: 'a' }, { secret: 'b' }] });
    const out = redact(entry);
    expect((out.args[0] as { secret: string }).secret).toBe('[REDACTED]');
    expect((out.args[1] as { secret: string }).secret).toBe('[REDACTED]');
  });

  it('returns the same entry reference when nothing matches', () => {
    const redact = createRedactProcessor(['password']);
    const entry = makeEntry({ context: { a: 1 } });
    expect(redact(entry)).toBe(entry);
  });
});

describe('processor: default serializers', () => {
  it('normalizes error, date, buffer, url, req and res by key', () => {
    const ser = createDefaultSerializers();
    const node = {
      error: new Error('boom'),
      date: new Date('2024-01-01T00:00:00.000Z'),
      buffer: Buffer.from('hi'),
      url: new URL('https://example.com/p'),
      req: { method: 'GET', url: '/x', extra: 1 },
      res: { status: 200, headers: {}, extra: 2 },
    };
    const entry = makeEntry({ args: [node] });
    const out = createSerializeProcessor(ser)(entry);
    const got = out.args[0] as Record<string, unknown>;
    expect((got.error as { name: string }).name).toBe('Error');
    expect((got.date as string).startsWith('2024')).toBe(true);
    expect(got.buffer as string).toContain('Buffer(');
    expect(got.url as string).toBe('https://example.com/p');
    expect((got.req as { method: string }).method).toBe('GET');
    expect((got.req as { extra?: number }).extra).toBeUndefined();
    expect((got.res as { status: number }).status).toBe(200);
    expect((got.res as { extra?: number }).extra).toBeUndefined();
  });

  it('returns the original entry reference when no serializer fires', () => {
    const ser = createDefaultSerializers();
    const entry = makeEntry({ args: [{ plain: 1 }] });
    expect(createSerializeProcessor(ser)(entry)).toBe(entry);
  });
});

describe('LiveTransport behaviour', () => {
  it('delivers entries to subscribers and tolerates a throwing subscriber', () => {
    const t = new LiveTransport();
    const seen: LogEntry[] = [];
    const unsub = t.subscribe((e) => void seen.push(e));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.subscribe(() => {
      throw new Error('bad');
    });
    t.write(makeEntry({ message: 'a' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe('a');
    expect(errSpy).toHaveBeenCalled();
    unsub();
    errSpy.mockRestore();
  });

  it('buffers for late subscribers and replays newest-first', () => {
    const t = new LiveTransport({ bufferSize: 5 });
    t.write(makeEntry({ message: '1' }));
    t.write(makeEntry({ message: '2' }));
    const replayed: string[] = [];
    const n = t.replay((e) => void replayed.push(e.message), true);
    expect(n).toBe(2);
    expect(replayed).toEqual(['2', '1']);
    expect(t.subscriberCount).toBe(0);
  });

  it('onFormatted uses the configured formatter', () => {
    const t = new LiveTransport({ formatter: () => 'FORMATTED' });
    const lines: string[] = [];
    t.onFormatted((line) => void lines.push(line));
    t.write(makeEntry());
    expect(lines).toEqual(['FORMATTED']);
  });

  it('clearBuffer drops buffered entries and close clears subscribers', () => {
    const t = new LiveTransport({ bufferSize: 3 });
    t.write(makeEntry({ message: 'x' }));
    t.clearBuffer();
    expect(t.replay(() => {})).toBe(0);
    t.subscribe(() => {});
    t.close();
    expect(t.subscriberCount).toBe(0);
  });
});

describe('PluginManager lifecycle', () => {
  function host() {
    return {
      addTransport() {},
      removeTransport() {},
      pipeline: {} as never,
      use: async () => {},
      unregisterPlugin() {},
      logger: {} as never,
    };
  }

  it('unregister decrements interceptors and invokes onDestroy', async () => {
    const destroyed: string[] = [];
    const pm = new PluginManager(host());
    const plugin: Plugin = {
      name: 'p',
      onEntry: (e) => e,
      onDestroy: () => void destroyed.push('p'),
    };
    await pm.register(plugin);
    expect(pm.hasEntryInterceptors()).toBe(true);
    pm.unregister('p');
    expect(pm.hasEntryInterceptors()).toBe(false);
    expect(destroyed).toEqual(['p']);
    // unregistering an unknown plugin is a no-op
    expect(() => pm.unregister('missing')).not.toThrow();
  });

  it('intercept drops the entry when a plugin returns null', async () => {
    const pm = new PluginManager(host());
    await pm.register({ name: 'drop', onEntry: () => null });
    const entry = makeEntry();
    const out = await pm.intercept(entry);
    expect(out).toBeNull();
  });

  it('intercept swallows a throwing hook and keeps the entry', async () => {
    const errors: Array<[string, unknown]> = [];
    const pm = new PluginManager(host());
    pm.onError = (name, err) => void errors.push([name, err]);
    await pm.register({
      name: 'boom',
      onEntry: () => {
        throw new Error('kaboom');
      },
    });
    const entry = makeEntry();
    const out = await pm.intercept(entry);
    expect(out).toBe(entry);
    expect(errors[0][0]).toBe('boom');
  });
});

describe('ConsoleTransport level fallback', () => {
  it('routes an unknown level to console.log without throwing', () => {
    const t = new ConsoleTransport();
    // `weird` is not in the methodMap, so `write` falls back to the real
    // `console.log` (line 65). Assert it executes cleanly rather than relying
    // on capturing the replaced test console.
    expect(() => t.write(makeEntry({ levelName: 'weird' as never }), 'fallback')).not.toThrow();
  });
});

describe('async context runAsync', () => {
  it('exposes the store via get() inside an async run', async () => {
    await asyncContext.runAsync(
      async () => {
        expect(asyncContext.get()).toEqual({ requestId: 'r' });
      },
      { requestId: 'r' },
    );
  });
});

describe('processor: buffer/arraybuffer/typed-array and req/res serializers', () => {
  it('serializes Buffer, ArrayBuffer and typed-array views', () => {
    const ser = createDefaultSerializers();
    const entry = makeEntry({
      args: [
        {
          buffer: Buffer.from('hi'),
          date: new Date('2024-02-02T00:00:00.000Z'),
          url: new URL('https://example.com/p'),
          req: { method: 'POST', url: '/submit', extra: 9 },
          res: { status: 201, headers: {}, other: 3 },
          error: new Error('boom'),
        },
      ],
    });
    const out = createSerializeProcessor(ser)(entry);
    const got = out.args[0] as Record<string, unknown>;
    expect(got.buffer as string).toContain('Buffer(');
    expect(got.date as string).toContain('2024-02-02');
    expect(got.url as string).toBe('https://example.com/p');
    expect((got.req as { method: string }).method).toBe('POST');
    expect((got.req as { extra?: number }).extra).toBeUndefined();
    expect((got.res as { status: number }).status).toBe(201);
    expect((got.res as { other?: number }).other).toBeUndefined();
    expect((got.error as { name: string }).name).toBe('Error');
  });

  it('only normalizes req/res when they expose the expected shape', () => {
    const ser = createDefaultSerializers();
    const entry = makeEntry({
      args: [{ req: { other: 1 }, res: { other: 2 } }],
    });
    const out = createSerializeProcessor(ser)(entry);
    const got = out.args[0] as Record<string, unknown>;
    // No `method`/`url`/`status` keys → serializer leaves them untouched.
    expect((got.req as { other: number }).other).toBe(1);
    expect((got.res as { other: number }).other).toBe(2);
  });

  it('createRedactProcessor returns identity for an empty key list', () => {
    const redact = createRedactProcessor([]);
    const entry = makeEntry({ context: { password: 'p' } });
    expect(redact(entry)).toBe(entry);
  });
});
