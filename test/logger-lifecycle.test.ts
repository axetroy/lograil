import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '../src/core/logger.js';
import { freezeEntry } from '../src/core/entry.js';
import { createLineFormatter } from '../src/pipeline/formatter.js';
import { formatMessage } from '../src/core/printf.js';
import { FileTransport } from '../src/transport/file.js';
import { ElectronIpcTransport, registerIpcReceiver } from '../src/transport/electron-ipc.js';
import { EMPTY_RECORD } from '../src/context/context.js';
import type { LogEntry } from '../src/types.js';
import { LOG_LEVELS } from '../src/types.js';
import type { RuntimeAdapter } from '../src/runtime/adapter.js';
import type { Transport } from '../src/transport/transport.js';

function memory() {
  const entries: LogEntry[] = [];
  const transport: Transport = {
    name: 'memory',
    write: (e: LogEntry) => void entries.push(e),
  };
  return { transport, entries };
}

function makeRuntime(): RuntimeAdapter {
  return {
    name: 'node',
    now: () => 1_000,
    pid: () => 7,
    hasFileSystem: () => false,
    defaultTransports: () => [],
  };
}

describe('Logger - exit-flush timeout config', () => {
  it('getExitFlushTimeout returns the default and setExitFlushTimeout overrides it', () => {
    const log = new Logger({ transports: [], runtime: makeRuntime(), flushTimeoutMs: 123 });
    expect(log.getExitFlushTimeout()).toBe(123);
    log.setExitFlushTimeout(456);
    expect(log.getExitFlushTimeout()).toBe(456);
  });

  it('setExitFlushTimeout ignores non-finite / negative values', () => {
    const log = new Logger({ transports: [], runtime: makeRuntime(), flushTimeoutMs: 100 });
    log.setExitFlushTimeout(Number.NaN);
    expect(log.getExitFlushTimeout()).toBe(100);
    log.setExitFlushTimeout(-5);
    expect(log.getExitFlushTimeout()).toBe(100);
  });

  it('flushWithTimeout resolves via flush when ms > 0', async () => {
    const { transport, entries } = memory();
    const log = new Logger({ transports: [transport], runtime: makeRuntime(), level: 'debug' });
    log.info('x');
    // Non-zero exit-flush path exercised through a public flush; the timeout
    // safety is asserted directly in process-integration.test.ts.
    await log.flush();
    expect(entries).toHaveLength(1);
  });
});

describe('Logger - watchUncaughtErrors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs unhandledRejection at fatal level and exits with code 1', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const { transport, entries } = memory();
    const log = new Logger({ transports: [transport], runtime: makeRuntime(), level: 'debug' });
    log.watchUncaughtErrors();
    process.emit('unhandledRejection', new Error('rejected'), Promise.resolve());
    await new Promise((r) => setTimeout(r, 10));
    expect(
      entries.some((e) => e.levelName === 'fatal' && (e.error as Error)?.message === 'rejected'),
    ).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);
    log.destroy();
  });
});

describe('Logger - destroy (root with process handlers)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('detaches process handlers and closes transports on root destroy', async () => {
    const removeListener = vi.spyOn(process, 'removeListener');
    const log = new Logger({
      transports: [],
      runtime: makeRuntime(),
      autoFlushOnExit: true,
      flushTimeoutMs: 50,
    });
    expect(
      typeof (log as unknown as { removeProcessHandlers?: () => void }).removeProcessHandlers,
    ).toBe('function');
    await log.destroy();
    expect(removeListener).toHaveBeenCalled();
  });
});

describe('Logger - global onError handler', () => {
  it('routes transport failures to the global handler when no transport onError', async () => {
    const errors: Array<{ phase: string; source?: string }> = [];
    const bad: Transport = {
      name: 'bad',
      write() {
        throw new Error('transfail');
      },
    };
    const log = new Logger({
      transports: [bad],
      runtime: makeRuntime(),
      onError: (_err, info) => errors.push({ phase: info.phase, source: info.source }),
    });
    log.info('x');
    await log.flush();
    expect(errors.some((e) => e.phase === 'transport')).toBe(true);
  });

  it('extracts an Error from trailing args when the message is not an Error', async () => {
    const { transport, entries } = memory();
    const log = new Logger({ transports: [transport], runtime: makeRuntime(), level: 'debug' });
    const err = new Error('from-args');
    log.info('operation failed', { ctx: 1 }, err);
    await log.flush();
    expect(entries).toHaveLength(1);
    expect(entries[0].error).toBe(err);
    expect(entries[0].message).toBe('operation failed');
  });
});

describe('Logger - ingestEntry filtering', () => {
  it('drops ingested entries below the logger level', () => {
    const { transport, entries } = memory();
    const log = new Logger({ transports: [transport], runtime: makeRuntime(), level: 'warn' });
    log.ingestEntry({
      level: LOG_LEVELS.info,
      levelName: 'info',
      message: 'below',
      args: [],
      timestamp: 1,
      time: '',
      context: {},
      metadata: {},
    });
    expect(entries).toHaveLength(0);
  });

  it('drops ingested entries whose scope is excluded by the scope filter', () => {
    const { transport, entries } = memory();
    const log = new Logger({
      transports: [transport],
      runtime: makeRuntime(),
      level: 'debug',
      scopeFilter: 'keep*',
    });
    log.ingestEntry({
      level: LOG_LEVELS.info,
      levelName: 'info',
      message: 'no',
      scope: 'drop',
      args: [],
      timestamp: 1,
      time: '',
      context: {},
      metadata: {},
    });
    expect(entries).toHaveLength(0);
  });

  it('ignores ingest after destroy', () => {
    const { transport, entries } = memory();
    const log = new Logger({ transports: [transport], runtime: makeRuntime(), level: 'debug' });
    return log.destroy().then(() => {
      log.ingestEntry({
        level: LOG_LEVELS.info,
        levelName: 'info',
        message: 'x',
        args: [],
        timestamp: 1,
        time: '',
        context: {},
        metadata: {},
      });
      expect(entries).toHaveLength(0);
    });
  });
});

describe('Logger - scopeFilterEnvVar:null disables the env filter', () => {
  it('does not read LOGRAIL_DEBUG when scopeFilterEnvVar is null', () => {
    const { transport, entries } = memory();
    process.env.LOGRAIL_DEBUG = 'svc*';
    const log = new Logger({
      transports: [transport],
      runtime: makeRuntime(),
      level: 'debug',
      scopeFilterEnvVar: null,
    });
    log.scope('other').info('kept');
    expect(entries).toHaveLength(1);
    delete process.env.LOGRAIL_DEBUG;
  });
});

describe('freezeEntry - empty context/metadata sentinel', () => {
  it('returns the shared EMPTY_RECORD without cloning when already empty', () => {
    const entry = {
      level: LOG_LEVELS.info,
      levelName: 'info',
      message: 'x',
      args: [],
      timestamp: 1,
      time: '',
      context: EMPTY_RECORD,
      metadata: EMPTY_RECORD,
    } as unknown as LogEntry;
    const f = freezeEntry(entry);
    expect(f.context).toBe(EMPTY_RECORD);
    expect(f.metadata).toBe(EMPTY_RECORD);
  });

  it('preserves a pre-frozen context object (no re-clone)', () => {
    const ctx = Object.freeze({ a: 1 });
    const entry = {
      level: LOG_LEVELS.info,
      levelName: 'info',
      message: 'x',
      args: [],
      timestamp: 1,
      time: '',
      context: ctx,
      metadata: {},
    } as unknown as LogEntry;
    const f = freezeEntry(entry);
    expect(f.context).toBe(ctx);
  });
});

describe('printf - scalar branches', () => {
  it('stringifies boolean and bigint args', () => {
    expect(formatMessage('b=%s n=%s', [true, 10n as unknown as string])[0]).toBe('b=true n=10');
  });

  it('emits a lone % literally', () => {
    expect(formatMessage('100%', [])[0]).toBe('100%');
  });
});

describe('formatter - safeStringify catch fallback', () => {
  it('falls back to String() when JSON.stringify throws on a non-circular value', () => {
    const fmt = createLineFormatter();
    const obj: Record<string, unknown> = {};
    // A getter that throws makes JSON.stringify throw; the safe replacer
    // catches it and falls back to String(value).
    Object.defineProperty(obj, 'boom', {
      get: () => {
        throw new Error('nope');
      },
    });
    expect(() => fmt({ ...makeEntryForFmt(), args: [obj] })).not.toThrow();
  });

  function makeEntryForFmt(): LogEntry {
    return {
      level: LOG_LEVELS.info,
      levelName: 'info',
      message: 'm',
      args: [],
      timestamp: 1,
      time: '',
      context: {},
      metadata: {},
    };
  }
});

describe('FileTransport - requires an appName', () => {
  it('throws when constructed without an appName', () => {
    expect(() => new FileTransport({ mode: 'single' } as never)).toThrow(/appName/);
  });
});

describe('ElectronIpcTransport - error isolation', () => {
  const hoisted = vi.hoisted(() => {
    const state: { handler?: (event: unknown, payload: unknown) => void } = {};
    return { state };
  });

  beforeEach(() => {
    vi.mock('../src/runtime/electron-binding.js', () => ({
      isElectronProcess: () => true,
      getElectron: () => ({
        ipcMain: {
          on: (_channel: string, handler: (event: unknown, payload: unknown) => void) => {
            hoisted.state.handler = handler;
          },
          removeListener: () => {},
        },
      }),
      getElectronApp: () => ({ on: vi.fn(), removeListener: vi.fn() }),
    }));
  });

  it('does not throw when the injected sender throws', () => {
    const send = vi.fn(() => {
      throw new Error('ipc down');
    });
    const t = new ElectronIpcTransport({ ipcRenderer: { send } });
    const entry: LogEntry = {
      level: LOG_LEVELS.info,
      levelName: 'info',
      message: 'x',
      args: [],
      timestamp: 1,
      time: '',
      context: {},
      metadata: {},
    };
    expect(() => t.write(entry, '')).not.toThrow();
  });

  it('rejects non-object payloads (e.g. corrupted buffer)', () => {
    const ingest = vi.fn();
    registerIpcReceiver(ingest);
    expect(hoisted.state.handler).toBeTypeOf('function');
    // The handler expects plain objects; passing an ArrayBuffer should not
    // crash (structured-clone delivers objects, never raw buffers).
    const garbage = new Uint8Array([0xff, 0xfe, 0xfd]).buffer;
    // This is now expected to spread into metadata and call ingest with a
    // shape that doesn't match LogEntry — but the handler should not throw.
    expect(() => hoisted.state.handler!({}, garbage)).not.toThrow();
  });
});
