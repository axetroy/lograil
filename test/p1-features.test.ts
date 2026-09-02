import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '../src/core/logger.js';
import type { LogEntry, LogLevelName } from '../src/types.js';
import { ConsoleTransport } from '../src/transport/console.js';
import { createJsonFormatter } from '../src/pipeline/formatter.js';
import {
  createSerializeProcessor,
  createRedactProcessor,
  createDefaultSerializers,
} from '../src/pipeline/processor.js';
import { createOtelTracePlugin } from '../src/plugin/otel-trace.js';
import type { Transport } from '../src/transport/transport.js';

function memory(): Transport & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    name: 'mem',
    entries,
    write(entry) {
      entries.push(entry);
    },
  } as Transport & { entries: LogEntry[] };
}

function entry(levelName: LogLevelName, extra: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 30,
    levelName,
    message: 'm',
    args: [],
    timestamp: 0,
    time: 't',
    scope: undefined,
    pid: undefined,
    context: {},
    metadata: {},
    error: undefined,
    ...extra,
  } as LogEntry;
}

afterEach(() => {
  delete process.env.LOG_LEVEL;
  delete process.env.LOGRAIL_DEBUG;
});

describe('P1: ConsoleTransport.stderrLevels', () => {
  it('routes configured levels to console.error, overriding methodMap', () => {
    const spyInfo = vi.fn();
    const spyErr = vi.fn();
    const spyWarn = vi.fn();
    const t = new ConsoleTransport({
      methodMap: { info: spyInfo, error: spyErr, warn: spyWarn },
      stderrLevels: ['error', 'warn'],
    });

    t.write(entry('info'), 'x');
    t.write(entry('error'), 'x');
    t.write(entry('warn'), 'x');

    expect(spyInfo).toHaveBeenCalledTimes(1);
    // error & warn are forced to realConsole.error, NOT the methodMap spies.
    expect(spyErr).not.toHaveBeenCalled();
    expect(spyWarn).not.toHaveBeenCalled();
  });

  it('defaults error/fatal to stderr without affecting info', () => {
    const spyInfo = vi.fn();
    const t = new ConsoleTransport({ methodMap: { info: spyInfo } });
    t.write(entry('info'), 'x');
    expect(spyInfo).toHaveBeenCalledTimes(1);
    // error/fatal go to the real console.error (native), not the spy.
    expect(() => t.write(entry('error'), 'x')).not.toThrow();
    expect(() => t.write(entry('fatal'), 'x')).not.toThrow();
  });
});

describe('P1: JSON formatter flatten', () => {
  it('spreads context and metadata to the top level when flatten:true', () => {
    const fmt = createJsonFormatter({ flatten: true });
    const out = JSON.parse(
      fmt(entry('info', { context: { reqId: '1' }, metadata: { traceId: 't' }, message: 'hi' })),
    );
    expect(out.reqId).toBe('1');
    expect(out.traceId).toBe('t');
    expect(out.context).toBeUndefined();
    expect(out.metadata).toBeUndefined();
    expect(out.level).toBe('info');
  });

  it('keeps nested context/metadata by default', () => {
    const fmt = createJsonFormatter();
    const out = JSON.parse(fmt(entry('info', { context: { reqId: '1' } })));
    expect(out.context.reqId).toBe('1');
  });
});

describe('P1: default serializers & redaction', () => {
  it('createDefaultSerializers handles common types', () => {
    const proc = createSerializeProcessor(createDefaultSerializers());
    const out = proc(
      entry('info', {
        context: {
          date: new Date(0),
          url: new URL('http://a/'),
          buffer: Buffer.from('x'),
        },
        args: [{ req: { method: 'GET', url: '/x', headers: { h: 1 } } }],
      }),
    );
    expect(out.context.date).toBe(new Date(0).toISOString());
    expect(out.context.url).toBe('http://a/');
    expect(typeof out.context.buffer).toBe('string');
    expect((out.context.buffer as string).startsWith('Buffer(')).toBe(true);
    expect((out.args[0] as { req: unknown }).req).toEqual({
      method: 'GET',
      url: '/x',
      headers: { h: 1 },
    });
  });

  it('createRedactProcessor redacts common secrets by default', () => {
    const proc = createRedactProcessor();
    const out = proc(
      entry('info', {
        context: { password: 'p', token: 't' },
        args: [{ user: { apiKey: 'k' } }],
      }),
    );
    expect(out.context.password).toBe('[REDACTED]');
    expect(out.context.token).toBe('[REDACTED]');
    expect((out.args[0] as { user: { apiKey: unknown } }).user.apiKey).toBe('[REDACTED]');
  });
});

describe('P1: namespace filtering & LOG_LEVEL env', () => {
  it('drops entries whose scope does not match the filter', () => {
    const t = memory();
    const log = new Logger({ transports: [t], scopeFilter: 'http*,db*' });
    log.scope('http:server').info('a');
    log.scope('db:query').info('b');
    log.scope('auth').info('c');
    expect(t.entries.map((e) => e.scope)).toEqual(['http:server', 'db:query']);
  });

  it('supports excludes with a leading -', () => {
    const t = memory();
    const log = new Logger({ transports: [t], scopeFilter: '*,-http:noise' });
    log.scope('http:noise').info('drop');
    log.scope('http:ok').info('keep');
    expect(t.entries.map((e) => e.scope)).toEqual(['http:ok']);
  });

  it('LOG_LEVEL env overrides the configured level', () => {
    process.env.LOG_LEVEL = 'warn';
    const t = memory();
    const log = new Logger({ transports: [t] });
    log.info('below');
    log.warn('above');
    expect(t.entries.map((e) => e.levelName)).toEqual(['warn']);
  });

  it('LOGRAIL_DEBUG env supplies the namespace filter', () => {
    process.env.LOGRAIL_DEBUG = 'svc*';
    const t = memory();
    const log = new Logger({ transports: [t] });
    log.scope('svc:a').info('yes');
    log.scope('other').info('no');
    expect(t.entries.map((e) => e.scope)).toEqual(['svc:a']);
  });

  it('levelEnvVar:null disables the env override', () => {
    process.env.LOG_LEVEL = 'warn';
    const t = memory();
    const log = new Logger({ transports: [t], levelEnvVar: null });
    log.info('kept'); // default info level applies
    expect(t.entries.length).toBe(1);
  });
});

describe('P1: OTel trace plugin (optional dependency)', () => {
  it('is a no-op when @opentelemetry/api is not installed', async () => {
    const t = memory();
    const log = new Logger({ transports: [t] });
    await log.use(createOtelTracePlugin());
    log.info('x');
    await log.flush();
    expect(t.entries[0].metadata).toEqual({});
  });
});
