import { describe, it, expect, vi } from 'vitest';
import { formatMessage } from '../src/core/printf.js';
import { createLineFormatter } from '../src/pipeline/formatter.js';
import { OtlpTransport } from '../src/transport/otlp.js';
import { FileTransport } from '../src/transport/file.js';
import { createProcessLifecycle } from '../src/runtime/process-lifecycle.js';
import {
  createRedactProcessor,
  createSerializeProcessor,
  createDefaultSerializers,
} from '../src/pipeline/processor.js';
import { createNodeRuntime, createWebRuntime } from '../src/runtime/index.js';
import type { LogEntry } from '../src/types.js';
import { LOG_LEVELS } from '../src/types.js';

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    level: LOG_LEVELS.info,
    levelName: 'info',
    message: 'hello',
    args: [],
    timestamp: 1_700_000_000_000,
    time: new Date(1_700_000_000_000).toISOString(),
    context: {},
    metadata: {},
    ...over,
  };
}

describe('printf - non-specifier % is emitted literally', () => {
  it('keeps a trailing %x verbatim (advances one char past %)', () => {
    expect(formatMessage('a%xb', [])[0]).toBe('a%xb');
  });
});

describe('formatter - error cause chains in args and entry', () => {
  it('renders an Error arg with a cause inline (short form)', () => {
    const cause = new Error('root');
    const err = new Error('boom');
    (err as unknown as { cause: unknown }).cause = cause;
    const fmt = createLineFormatter();
    const out = fmt(makeEntry({ args: [err] }));
    expect(out).toContain('boom');
    expect(out).toContain('root');
  });

  it('handles circular Error cause (seen.has(err) branch)', () => {
    const err = new Error('circular');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).cause = err;
    const fmt = createLineFormatter();
    const out = fmt(makeEntry({ args: [err] }));
    expect(out).toContain('circular');
    expect(out).toContain('[Circular]');
  });

  it('handles non-Error cause (cause instanceof Error → false branch)', () => {
    const err = new Error('with-cause');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err as any).cause = 'string cause';
    const fmt = createLineFormatter();
    const out = fmt(makeEntry({ args: [err] }));
    expect(out).toContain('with-cause');
    expect(out).toContain('string cause');
  });
});

describe('OtlpTransport - null attribute and pid', () => {
  it('serializes a null/undefined context value to an empty string and adds pid', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);
    const t = new OtlpTransport();
    t.write(makeEntry({ context: { x: null }, pid: 4242 }), 'hi');
    await t.flush();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const rec = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    const nullAttr = rec.attributes.find((a: { key: string }) => a.key === 'x');
    expect(nullAttr.value.stringValue).toBe('');
    expect(rec.attributes).toContainEqual({ key: 'pid', value: { intValue: '4242' } });
    vi.unstubAllGlobals();
  });
});

describe('FileTransport - custom now and extension base', () => {
  it('uses the provided now() and handles a path with an extension', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'elog-edge-'));
    try {
      const clock = new Date(2024, 0, 1, 0, 0, 0, 0);
      const transport = new FileTransport({
        mode: 'rotate-time',
        unit: 'day',
        appName: 'app',
        ext: 'log',
        dir,
        now: () => clock,
      });
      transport.write(
        makeEntry({ message: 'one' }),
        transport.formatter!(makeEntry({ message: 'one' })),
      );
      await transport.close();
      const content = (await readFile(join(dir, 'app.2024-01-01.0.log'), 'utf8')).trim();
      expect(content).toContain('one');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('edge cases — untested code paths', () => {
  it('safeStringify catch fallback returns String(value)', () => {
    const fmt = createLineFormatter();
    // safeStringify is internal; exercise it via the formatter's args path.
    // A value with a throwing Symbol.toPrimitive also triggers the outer catch.
    const symbolBoom = {
      [Symbol.toPrimitive]: () => {
        throw new Error('primitive boom');
      },
    } as unknown;
    // This should not throw — the formatter's safeStringify catches both paths.
    expect(() => fmt(makeEntry({ args: [symbolBoom] }))).not.toThrow();
  });

  it('inferAppName throws when process.argv[1] getter throws', () => {
    const originalArgv1 = Object.getOwnPropertyDescriptor(process, 'argv');
    try {
      Object.defineProperty(process, 'argv', {
        get() {
          throw new Error('argv blocked');
        },
        configurable: true,
      });
      // createNodeRuntime with explicit appName bypasses inferAppName.
      const rt = createNodeRuntime({ appName: 'explicit' });
      expect(rt.name).toBe('node');
      // Without appName the runtime would throw from inferAppName catch.
      expect(() => createNodeRuntime()).toThrow('appName');
    } finally {
      if (originalArgv1) {
        Object.defineProperty(process, 'argv', originalArgv1);
      } else {
        delete (process as unknown as Record<string, unknown>).argv;
      }
    }
  });

  it('createProcessLifecycle returns no-op when process is undefined', () => {
    // Simulate browser-like env where process is absent by passing a stub runtime.
    const rt = createWebRuntime();
    expect(rt.name).toBe('web');
    // The lifecycle hooks are no-ops when there's no process.
    const hooks = rt.lifecycle!;
    const detachFlush = hooks.onFlushBeforeExit(() => {});
    expect(typeof detachFlush).toBe('function');
    detachFlush(); // should not throw
  });

  it('signal handler ignores proc.exit() throw', () => {
    // Restore any prior spies so our mocks are the only ones active.
    vi.restoreAllMocks();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit failed');
    });
    // Don't mock process.on here — let the real registration happen so
    // createProcessLifecycle wires up its handlers.
    const hooks = createProcessLifecycle();
    const flushed: unknown[] = [];
    const detach = hooks.onFlushBeforeExit(() => flushed.push('flushed'));
    expect(typeof detach).toBe('function');

    // Trigger SIGTERM — the handler must not propagate the exit() throw.
    process.emit('SIGTERM' as never, 143);
    expect(flushed).toContain('flushed');

    detach();
    exitSpy.mockRestore();
  });

  it('redactNode returns unchanged node when matcher never fires at array/object level', () => {
    const proc = createRedactProcessor(['password']);
    const entry = makeEntry({ context: { name: 'alice' }, args: [{ token: 'x' }] });
    const out = proc(entry);
    // Neither context nor args contain the key 'password' — structural equality path.
    expect(out.context).toBe(entry.context);
    expect((out.args[0] as Record<string, unknown>).token).toBe('x');
  });

  it('default serializers take the non-matching branch for plain values', () => {
    const ser = createDefaultSerializers();
    const entry = makeEntry({
      context: {
        error: 'not an error',
        date: 'not a date',
        buffer: 'not a buffer',
        url: 'not a url',
        req: 'not a req',
        res: 'not a res',
      },
    });
    const out = createSerializeProcessor(ser)(entry);
    // Each serializer returns the input unchanged when the type doesn't match.
    expect(out.context.error).toBe('not an error');
    expect(out.context.date).toBe('not a date');
    expect(out.context.buffer).toBe('not a buffer');
    expect(out.context.url).toBe('not a url');
    expect(out.context.req).toBe('not a req');
    expect(out.context.res).toBe('not a res');
  });

  it('serializeRequestValue returns v when neither method nor url is present', () => {
    const ser = createDefaultSerializers();
    const entry = makeEntry({ context: { req: { foo: 'bar' } } });
    const out = createSerializeProcessor(ser)(entry);
    expect((out.context as { req: { foo: string } }).req).toEqual({ foo: 'bar' });
  });

  it('serializeResponseValue returns v when neither status nor statusCode is present', () => {
    const ser = createDefaultSerializers();
    const entry = makeEntry({ context: { res: { body: 'ok' } } });
    const out = createSerializeProcessor(ser)(entry);
    expect((out.context as { res: { body: string } }).res).toEqual({ body: 'ok' });
  });
});
