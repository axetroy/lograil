import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/index.js';
import { formatMessage, hasPrintfSpecifier } from '../src/core/printf.js';
import type { LogEntry } from '../src/types.js';
import type { RuntimeAdapter } from '../src/runtime/index.js';
import type { Transport } from '../src/transport/transport.js';

function captureRuntime(): RuntimeAdapter {
  return {
    name: 'node',
    now: () => 0,
    pid: () => 1,
    hasFileSystem: () => false,
    defaultTransports: () => [],
  } as unknown as RuntimeAdapter;
}

function captureLogger() {
  const entries: LogEntry[] = [];
  const transport: Transport = { name: 'cap', write: (e: LogEntry) => void entries.push(e) };
  const log = createLogger({ runtime: captureRuntime(), transports: [transport] });
  return { log, entries };
}

describe('formatMessage (printf)', () => {
  it('formats %s', () => {
    expect(formatMessage('hi %s', ['bob'])[0]).toBe('hi bob');
  });
  it('formats %d and %i as numbers', () => {
    expect(formatMessage('n=%d', [42])[0]).toBe('n=42');
    expect(formatMessage('n=%i', ['7' as unknown as number])[0]).toBe('n=7');
  });
  it('%d renders non-number inputs via Number()', () => {
    expect(formatMessage('x=%d', ['42' as unknown as number])[0]).toBe('x=42');
    expect(formatMessage('x=%d', [true as unknown as number])[0]).toBe('x=1');
  });
  it('formats %j as JSON and falls back on circular refs', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(formatMessage('payload=%j', [{ a: 1 }])[0]).toBe('payload={"a":1}');
    // JSON.stringify throws on circular -> falls back to String()
    expect(formatMessage('c=%j', [circular])[0]).toContain('[object Object]');
  });
  it('formats %o/%O as object preview with multiple keys and arrays', () => {
    const out = formatMessage('obj=%o', [{ a: 1, b: 2 }])[0];
    expect(out).toContain('a: 1');
    expect(out).toContain('b: 2');
    expect(formatMessage('arr=%o', [[1, 2, 3]])[0]).toContain('[1, 2, 3]');
  });
  it('%o preview truncates beyond 8 keys', () => {
    const big = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 };
    const out = formatMessage('o=%o', [big])[0];
    expect(out).toContain('…+1');
  });
  it('stringifies functions, bigint, null and undefined', () => {
    expect(formatMessage('f=%s', [(() => {}) as unknown as string])[0]).toContain('[Function:');
    expect(formatMessage('b=%s', [10n as unknown as string])[0]).toBe('b=10');
    expect(formatMessage('n=%s', [null as unknown as string])[0]).toBe('n=null');
    expect(formatMessage('u=%s', [undefined as unknown as string])[0]).toBe('u=undefined');
  });
  it('keeps trailing (unconsumed) args as rest', () => {
    const [msg, ...rest] = formatMessage('u=%s', ['bob', { extra: true }]);
    expect(msg).toBe('u=bob');
    expect(rest).toEqual([{ extra: true }]);
  });
  it('literal %% becomes a single %', () => {
    expect(formatMessage('100%% done', [])[0]).toBe('100% done');
  });
  it('hasPrintfSpecifier rejects plain text and garbage', () => {
    expect(hasPrintfSpecifier('no spec')).toBe(false);
    expect(hasPrintfSpecifier('%z')).toBe(false);
    expect(hasPrintfSpecifier('%s')).toBe(true);
  });
});

describe('Logger printf integration', () => {
  it('formats a string message with %s arg', () => {
    const { log, entries } = captureLogger();
    log.info('user %s logged in', 'bob');
    expect(entries[0].message).toBe('user bob logged in');
  });

  it('keeps non-specifier % literal and preserves args', () => {
    const { log, entries } = captureLogger();
    log.info('discount 50% off', { code: 'SALE' });
    expect(entries[0].message).toBe('discount 50% off');
    expect(entries[0].args).toEqual([{ code: 'SALE' }]);
  });

  it('info("msg", {obj}) stays on the no-format path (message + obj preserved)', () => {
    const { log, entries } = captureLogger();
    log.info('event', { userId: 42 });
    expect(entries[0].message).toBe('event');
    expect(entries[0].args).toEqual([{ userId: 42 }]);
  });

  it('passes unconsumed printf args through as structured args', () => {
    const { log, entries } = captureLogger();
    log.info('user %s', 'bob', { requestId: 'r1' });
    expect(entries[0].message).toBe('user bob');
    expect(entries[0].args).toEqual([{ requestId: 'r1' }]);
  });
});
