import { describe, it, expect } from 'vitest';
import type { LogEntry } from '../src/types.js';
import { createRedactProcessor } from '../src/pipeline/processor.js';

function entry(ctx: Record<string, unknown>, args: unknown[] = []): LogEntry {
  return {
    level: 30,
    levelName: 'info',
    message: 'm',
    args,
    timestamp: 0,
    time: '',
    context: ctx,
    metadata: {},
  } as unknown as LogEntry;
}

describe('Processor - redact (paths)', () => {
  it('redacts by exact path only', () => {
    const redact = createRedactProcessor(['user.password']);
    const out = redact(entry({ user: { password: 'a', name: 'b' }, nested: { password: 'c' } }));
    const c = out.context as Record<string, unknown>;
    expect((c.user as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((c.user as Record<string, unknown>).name).toBe('b');
    expect((c.nested as Record<string, unknown>).password).toBe('c'); // untouched
  });

  it('redacts with wildcards', () => {
    const redact = createRedactProcessor(['*.password']);
    const out = redact(entry({ user: { password: 'a' }, nested: { password: 'b' } }));
    const c = out.context as Record<string, unknown>;
    expect((c.user as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((c.nested as Record<string, unknown>).password).toBe('[REDACTED]');
  });

  it('redacts object args and nested array elements', () => {
    const redact = createRedactProcessor(['password']);
    const out = redact(entry({}, [{ user: { password: 'x' } }, [{ password: 'y' }]]));
    const a = out.args as unknown[];
    expect(((a[0] as Record<string, unknown>).user as Record<string, unknown>).password).toBe(
      '[REDACTED]',
    );
    expect(((a[1] as unknown[])[0] as Record<string, unknown>).password).toBe('[REDACTED]');
  });

  it('uses a custom replacement and does not mutate the original', () => {
    const redact = createRedactProcessor(['password'], '***');
    const orig = { user: { password: 'a' } };
    const out = redact(entry(orig));
    expect(
      ((out.context as Record<string, unknown>).user as Record<string, unknown>).password,
    ).toBe('***');
    expect(orig.user.password).toBe('a');
  });

  it('returns the same entry reference when nothing matches', () => {
    const redact = createRedactProcessor(['password']);
    const e = entry({ foo: 'bar' });
    expect(redact(e)).toBe(e);
  });

  it('redacts cyclic objects without breaking their cycles', () => {
    const redact = createRedactProcessor(['password']);
    const original: Record<string, unknown> = { password: 'secret' };
    original.self = original;

    const out = redact(entry({}, [original]));
    const redacted = out.args[0] as Record<string, unknown>;

    expect(redacted).not.toBe(original);
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.self).toBe(redacted);
    expect(original.password).toBe('secret');
  });

  it('redacts array elements by path', () => {
    const redact = createRedactProcessor(['list.0.token']);
    const out = redact(entry({ list: [{ token: 'secret', id: 1 }, { token: 'keep' }] }));
    const list = (out.context as Record<string, unknown>).list as unknown[];
    expect((list[0] as Record<string, unknown>).token).toBe('[REDACTED]');
    expect((list[0] as Record<string, unknown>).id).toBe(1);
    expect((list[1] as Record<string, unknown>).token).toBe('keep');
  });

  it('supports a bare-key glob (any depth) and a dotted wildcard combined', () => {
    const redact = createRedactProcessor(['token', 'user.*']);
    const out = redact(
      entry({ user: { name: 'bob', ssn: 'x' }, token: 't', other: { token: 'deep' } }),
    );
    const c = out.context as Record<string, unknown>;
    // bare 'token' matches at any depth
    expect(c.token).toBe('[REDACTED]');
    expect((c.other as Record<string, unknown>).token).toBe('[REDACTED]');
    // 'user.*' matches every key under user
    const user = c.user as Record<string, unknown>;
    expect(user.name).toBe('[REDACTED]');
    expect(user.ssn).toBe('[REDACTED]');
  });

  it('returns the same entry when given an empty key list', () => {
    const redact = createRedactProcessor([]);
    const e = entry({ foo: 'bar' });
    expect(redact(e)).toBe(e);
  });

  it('clones and redacts array elements without mutating the original array', () => {
    const redact = createRedactProcessor(['password']);
    const orig = [{ password: 'a' }, { password: 'b' }];
    const out = redact(entry({}, orig));
    expect((out.args as Record<string, unknown>[])[0].password).toBe('[REDACTED]');
    expect(orig[0].password).toBe('a'); // original untouched
  });

  it('does not pollute the global Object.prototype when redacting a __proto__ key', () => {
    const redact = createRedactProcessor(['password']);
    // Simulate untrusted input that carries a literal `__proto__` own key.
    const malicious: Record<string, unknown> = {
      password: 'secret',
      [Object.getOwnPropertyNames({} as object)[0]]: 'irrelevant',
    };
    // Build an object whose own key is literally `__proto__` without letting
    // the literal assignment trigger the prototype setter.
    Object.defineProperty(malicious, '__proto__', {
      value: { admin: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const out = redact(entry(malicious));
    const c = out.context as Record<string, unknown>;
    // The matched `password` was redacted.
    expect(c.password).toBe('[REDACTED]');
    // Crucially, the global Object.prototype must NOT have gained an `admin`
    // property — that is the classic prototype-pollution exploit.
    expect((Object.prototype as Record<string, unknown>).admin).toBeUndefined();
    // A fresh object must not be affected either.
    expect({} as unknown as Record<string, unknown>).not.toHaveProperty('admin');
  });

  it('redacts values nested inside Map entries', () => {
    const redact = createRedactProcessor(['password']);
    const m = new Map<string, unknown>([
      ['user', { password: 'a', name: 'b' }],
      ['safe', 'ok'],
    ]);
    const out = redact(entry({ m }));
    const c = out.context as Record<string, unknown>;
    const outMap = c.m as Map<string, unknown>;
    expect(outMap instanceof Map).toBe(true);
    const user = outMap.get('user') as Record<string, unknown>;
    expect(user.password).toBe('[REDACTED]');
    expect(user.name).toBe('b');
    expect(outMap.get('safe')).toBe('ok');
    // original Map untouched
    expect((m.get('user') as Record<string, unknown>).password).toBe('a');
  });

  it('redacts values nested inside Set entries', () => {
    const redact = createRedactProcessor(['password']);
    const s = new Set<Record<string, unknown>>([{ password: 'a', id: 1 }]);
    const out = redact(entry({ s }));
    const c = out.context as Record<string, unknown>;
    const outSet = c.s as Set<Record<string, unknown>>;
    expect(outSet instanceof Set).toBe(true);
    const only = outSet.values().next().value as Record<string, unknown>;
    expect(only.password).toBe('[REDACTED]');
    expect(only.id).toBe(1);
    // original set untouched
    expect((s.values().next().value as Record<string, unknown>).password).toBe('a');
  });
});
