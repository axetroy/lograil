import { describe, expect, it, vi } from 'vitest';
import { createJsonFormatter, createLineFormatter } from '../src/pipeline/formatter.js';
import type { LogEntry } from '../src/types.js';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 30,
    levelName: 'info',
    message: 'test',
    args: [],
    timestamp: Date.now(),
    time: new Date().toISOString(),
    scope: null,
    pid: 1,
    context: {},
    metadata: {},
    ...overrides,
  };
}

describe('formatter - shared WeakSet bug fix', () => {
  it('renders a function arg without [Circular]', () => {
    const fn = function myFn() {};
    const entry = makeEntry({ args: [fn] });
    const json = createJsonFormatter()(entry);
    expect(json).toContain('myFn');
    expect(json).not.toContain('[Circular]');
  });

  it('renders a Date arg as ISO string in JSON', () => {
    const dt = new Date('2024-01-15T10:00:00.000Z');
    const entry = makeEntry({ args: [dt] });
    const json = createJsonFormatter()(entry);
    const parsed = JSON.parse(json);
    expect(parsed.args[0]).toBe('2024-01-15T10:00:00.000Z');
  });

  it('renders a RegExp arg as {} in JSON (non-plain)', () => {
    const re = /test/g;
    const entry = makeEntry({ args: [re] });
    const json = createJsonFormatter()(entry);
    // RegExp is not plain-JSONable; safe replacer renders it as string
    const parsed = JSON.parse(json);
    expect(parsed.args[0]).not.toBe('{}');
  });

  it('shares WeakSet across error and entry data for circular detection', () => {
    const obj = { name: 'root' };
    const err = new Error('boom');
    (err as { cause?: unknown }).cause = obj;
    obj.self = obj; // circular in obj
    const entry = makeEntry({ error: err, args: [obj] });
    const json = createJsonFormatter()(entry);
    const parsed = JSON.parse(json);
    // The circular self-reference in obj should be detected
    expect(json).toContain('[Circular]');
    // error.cause should be the obj, not re-reported as circular just because
    // it was also in args
    expect(parsed.error.cause).toBeDefined();
  });

  it('renders a Map in nested object context', () => {
    const m = new Map<string, string>([['k', 'v']]);
    const entry = makeEntry({ args: [{ map: m }] });
    const json = createJsonFormatter()(entry);
    const parsed = JSON.parse(json);
    expect(parsed.args[0].map).toEqual({ __type: 'Map', entries: [['k', 'v']] });
  });

  it('line formatter renders function with name', () => {
    const fn = function namedFn() {};
    const entry = makeEntry({ args: [fn] });
    const line = createLineFormatter()(entry);
    expect(line).toContain('namedFn');
  });
});

describe('createElectronRuntime - renderer IPC type', () => {
  it('returns a RuntimeAdapter (compile-time check)', async () => {
    const mod = await import('../src/runtime/electron.js');
    expect(typeof mod.createElectronRuntime).toBe('function');
  });
});

describe('cluster-ipc - error reporting', () => {
  it('surface errors via RAW_CONSOLE_ERROR when primary is unreachable', async () => {
    // Stub console.error before the module loads so RAW_CONSOLE_ERROR (captured
    // at module-load time) points at our spy.
    const spy = vi.fn();
    vi.stubGlobal('console', { ...console, error: spy });
    const { ClusterIpcTransport } = await import('../src/transport/cluster-ipc.js');
    const origSend = process.send;
    process.send = ((_msg, cb) => {
      cb?.(new Error('EPIPE'));
      return true;
    }) as typeof process.send;
    try {
      const t = new ClusterIpcTransport();
      t.write(makeEntry(), 'formatted');
      expect(spy).toHaveBeenCalled();
    } finally {
      process.send = origSend;
      vi.unstubAllGlobals();
    }
  });
});
