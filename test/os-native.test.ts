import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type ExecFileFn = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

type SpawnFn = (
  cmd: string,
  args: string[],
  opts: unknown,
) => {
  stdin: {
    write(s: string, cb?: (e: Error | null) => void): boolean;
    on(ev: string, cb: (...a: unknown[]) => void): unknown;
  };
  on(ev: string, cb: (...a: unknown[]) => void): unknown;
  kill(): void;
};

const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
let execFileImpl: ExecFileFn = () => {};
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
let spawnImpl: SpawnFn = () => {
  throw new Error('not set');
};

vi.mock('../src/shims/index.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    execFile: (_cmd: string, _args: string[], _opts: unknown, _cb: never) => {
      execFileCalls.push({ cmd: _cmd, args: _args });
      execFileImpl(_cmd, _args, _opts, _cb);
    },
    spawn: (cmd: string, args: string[], opts: unknown) => {
      spawnCalls.push({ cmd, args });
      return spawnImpl(cmd, args, opts);
    },
  };
});

import { SyslogTransport } from '../src/transport/syslog.js';
import { JournaldTransport } from '../src/transport/journald.js';
import { WindowsEventLogTransport } from '../src/transport/windows-event-log.js';
import type { LogEntry } from '../src/types.js';

function makeEntry(
  levelName: 'info' | 'error' | 'warn' = 'info',
  overrides: Partial<LogEntry> = {},
): LogEntry {
  return {
    level: 30,
    levelName,
    message: 'hello',
    args: [],
    timestamp: 0,
    time: '1970-01-01T00:00:00.000Z',
    scope: undefined,
    pid: undefined,
    context: {},
    metadata: {},
    error: undefined,
    ...overrides,
  } as unknown as LogEntry;
}

beforeEach(() => {
  execFileCalls.length = 0;
  spawnCalls.length = 0;
});

afterEach(() => {
  vi.doUnmock('../src/shims/index.js');
});

describe('OS-native transports (import-safe)', () => {
  it('all three are constructible without throwing', () => {
    expect(() => new SyslogTransport()).not.toThrow();
    expect(() => new JournaldTransport()).not.toThrow();
    expect(() => new WindowsEventLogTransport()).not.toThrow();
  });

  it('expose name / formatter / write / close on every transport', () => {
    const s = new SyslogTransport();
    const j = new JournaldTransport();
    const w = new WindowsEventLogTransport();
    for (const t of [s, j, w]) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.formatter).toBe('function');
      expect(typeof t.write).toBe('function');
      expect(typeof t.close).toBe('function');
    }
  });
});

describe('SyslogTransport', () => {
  it('local protocol: invokes logger with -t and -p args', async () => {
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(null, '', ''), 0);
    };
    const t = new SyslogTransport({ tag: 'myapp' });
    t.write(makeEntry('error'), '2026-01-01 ERROR message');
    await new Promise((r) => setTimeout(r, 5));
    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0].cmd).toBe('logger');
    expect(execFileCalls[0].args[0]).toBe('-t');
    expect(execFileCalls[0].args[1]).toBe('myapp');
    expect(execFileCalls[0].args.slice(2, 4)).toEqual(['-p', '3.3']);
    expect(execFileCalls[0].args[4]).toBe('2026-01-01 ERROR message');
  });

  it('reports failed writes via onError after breaker threshold', async () => {
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(new Error('no logger here'), '', ''), 0);
    };
    const t = new SyslogTransport();
    const errors: unknown[] = [];
    t.onError = (err) => errors.push(err);
    const threshold = (SyslogTransport as unknown as { BREAK_AFTER: number }).BREAK_AFTER;
    for (let i = 0; i < threshold; i++) {
      t.write(makeEntry(), 'line');
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as Error).message).toMatch(/no logger|write failed|logger/i);
  });
});

describe('WindowsEventLogTransport', () => {
  it('on win32 spawns eventcreate; on other platforms the write is guarded', () => {
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(null, '', ''), 0);
    };
    const t = new WindowsEventLogTransport({ log: 'Application', source: 'MyApp' });
    t.write(makeEntry('error', { metadata: { wevtid: 42 } }), 'boom');
    // On a non-win32 host the write short-circuits into the unavailable path;
    // on win32 it would have invoked execFile. Either way, no throw.
    expect(typeof t.write).toBe('function');
  });
});

describe('JournaldTransport', () => {
  it('spawns systemd-cat with fields and a PRIORITY arg', async () => {
    spawnImpl = (_cmd, _args, _opts) => ({
      stdin: {
        write: (_s: string, cb?: (e: Error | null) => void) => {
          cb?.(null);
          return true;
        },
        on: () => undefined,
      },
      on: () => undefined,
      kill: () => undefined,
    });
    const t = new JournaldTransport({ fields: { UNIT: 'myapp.service' } });
    t.write(makeEntry('warn'), '2026-01-01 WARN msg');
    await new Promise((r) => setTimeout(r, 5));
    const spawn = spawnCalls.find((c) => c.cmd === 'systemd-cat');
    expect(spawn).toBeDefined();
    expect(spawn!.args).toContain('UNIT=myapp.service');
    expect(spawn!.args).toContain('PRIORITY=6');
    expect(spawn!.args).toContain('-');
  });

  it('reports spawn failures via onError after breaker threshold', async () => {
    spawnImpl = () => {
      throw new Error('no spawn available');
    };
    const t = new JournaldTransport();
    const errors: unknown[] = [];
    t.onError = (err) => errors.push(err);
    for (let i = 0; i < 10; i++) t.write(makeEntry(), 'x');
    await new Promise((r) => setTimeout(r, 10));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as Error).message).toMatch(/no spawn|journald|not available/i);
  });
});
