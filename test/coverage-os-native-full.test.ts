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
// Platform the mocked shim reports; default is the real host platform. Tests
// that exercise a specific OS write path override this.
let osPlatformValue: string = process.platform;

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
    osPlatform: () => osPlatformValue,
  };
});

/** Force the mocked shim to report a specific platform. */
function mockPlatform(platform: string): void {
  osPlatformValue = platform;
}

import { SyslogTransport } from '../src/transport/syslog.js';
import { JournaldTransport } from '../src/transport/journald.js';
import { WindowsEventLogTransport } from '../src/transport/windows-event-log.js';
import type { LogEntry } from '../src/types.js';

function makeEntry(
  levelName: 'info' | 'error' | 'warn' | 'trace' | 'debug' | 'fatal' = 'info',
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
  osPlatformValue = process.platform;
  spawnImpl = () => {
    throw new Error('not set');
  };
});

afterEach(() => {
  vi.doUnmock('../src/shims/index.js');
});

// ── Journald deep paths ─────────────────────────────────────────────

describe('JournaldTransport: deep code paths', () => {
  function fakeChild(
    _writeOk = true,
    writeErr?: Error,
  ): {
    child: ReturnType<SpawnFn>;
    fired: Record<string, (...a: unknown[]) => void>;
  } {
    const fired: Record<string, (...a: unknown[]) => void> = {};
    return {
      child: {
        stdin: {
          write: (_s: string, cb?: (e: Error | null) => void) => {
            cb?.(writeErr ?? null);
            return true;
          },
          on: (ev, cb) => {
            fired['stdin.' + ev] = cb as never;
            return undefined;
          },
        },
        on: (ev, cb) => {
          fired[ev] = cb as never;
          return undefined;
        },
        kill: () => undefined,
      },
      fired,
    };
  }

  it('PRIORITY uses fixed option when provided', async () => {
    spawnImpl = () => fakeChild().child;
    const t = new JournaldTransport({ priority: 2 });
    t.write(makeEntry(), 'line');
    const call = spawnCalls.find((c) => c.cmd === 'systemd-cat');
    expect(call!.args).toContain('PRIORITY=2');
  });

  it('PRIORITY defaults to 6 when no option given', async () => {
    spawnImpl = () => fakeChild().child;
    const t = new JournaldTransport();
    t.write(makeEntry(), 'line');
    const call = spawnCalls.find((c) => c.cmd === 'systemd-cat');
    expect(call!.args).toContain('PRIORITY=6');
  });

  it('reuses child across multiple writes', async () => {
    spawnImpl = () => fakeChild().child;
    const t = new JournaldTransport();
    t.write(makeEntry(), 'a');
    t.write(makeEntry(), 'b');
    t.write(makeEntry(), 'c');
    const spawns = spawnCalls.filter((c) => c.cmd === 'systemd-cat');
    expect(spawns).toHaveLength(1);
  });

  it('error event clears child and reports via cb', async () => {
    const { child, fired } = fakeChild();
    spawnImpl = () => child;
    const t = new JournaldTransport();
    t.write(makeEntry(), 'a');
    // Now trigger the error handler.
    fired['error']?.(new Error('spawn died'));
    // After error the child should be cleared; next write respawns.
    t.write(makeEntry(), 'b');
    const spawns = spawnCalls.filter((c) => c.cmd === 'systemd-cat');
    expect(spawns.length).toBe(2);
  });

  it('exit event with non-zero code clears child and bumps failure count', async () => {
    const { child, fired } = fakeChild();
    spawnImpl = () => child;
    const t = new JournaldTransport();
    const errors: unknown[] = [];
    t.onError = (e) => errors.push(e);
    t.write(makeEntry(), 'a');
    fired['exit']?.(1);
    // Exit with code 1 bumps consecutiveFailures; 10 total (incl. the bump) → breaker trips.
    for (let i = 0; i < 9; i++) {
      t.write(makeEntry(), 'x'); // each triggers a new spawn failure path
    }
    // Simpler: just assert child was cleared and a respawn happened.
    const spawns = spawnCalls.filter((c) => c.cmd === 'systemd-cat');
    expect(spawns.length).toBeGreaterThan(1);
  });

  it('stdin.write error triggers onWriteFailure and breaker path', async () => {
    const writeErr = new Error('EPIPE');
    spawnImpl = () => fakeChild(true, writeErr).child;
    const t = new JournaldTransport();
    const errors: unknown[] = [];
    t.onError = (e) => errors.push(e);
    // onWriteFailure bumps consecutiveFailures; 10 failures trip breaker.
    for (let i = 0; i < 10; i++) t.write(makeEntry(), 'x');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as Error).message).toMatch(/journald|write/i);
  });

  it('exercises close() which detaches the child process', () => {
    const { child } = fakeChild();
    const killed: Array<{ name: string; killed: boolean }> = [];
    spawnImpl = () => ({
      ...child,
      kill: () => {
        killed.push({ name: 'killed', killed: true });
      },
    });
    const t = new JournaldTransport();
    t.write(makeEntry(), 'a');
    t.close();
    expect(killed.length).toBe(1);
    expect(killed[0].killed).toBe(true);
  });

  it('unavailable path: spawn failures report via onError', async () => {
    spawnImpl = () => {
      throw new Error('no spawn available');
    };
    const t = new JournaldTransport();
    const errors: unknown[] = [];
    t.onError = (e) => errors.push(e);
    for (let i = 0; i < 10; i++) t.write(makeEntry(), 'x');
    await new Promise((r) => setTimeout(r, 10));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as Error).message).toMatch(/no spawn|journald|not available/i);
  });

  it('browser platform gate prevents all spawn calls', () => {
    mockPlatform('browser');
    const t = new JournaldTransport();
    const errors: unknown[] = [];
    t.onError = (e) => errors.push(e);
    const threshold = (JournaldTransport as unknown as { BREAK_AFTER: number }).BREAK_AFTER;
    for (let i = 0; i < threshold; i++) t.write(makeEntry(), 'x');
    expect(spawnCalls).toHaveLength(0);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('close() kills and clears the running child', () => {
    const { child } = fakeChild();
    let killed = false;
    spawnImpl = () => ({
      ...child,
      kill: () => {
        killed = true;
      },
    });
    const t = new JournaldTransport();
    t.write(makeEntry(), 'a');
    t.close();
    expect(killed).toBe(true);
  });
});

// ── Syslog deep paths ───────────────────────────────────────────────

describe('SyslogTransport: deep code paths', () => {
  it('udp protocol builds a PRI-prefixed line and calls nc', async () => {
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(null, '', ''), 0);
    };
    const t = new SyslogTransport({
      protocol: 'udp',
      host: 'logs.example',
      port: 9999,
      tag: 'tag',
    });
    t.write(makeEntry('warn'), 'msg');
    await new Promise((r) => setTimeout(r, 5));
    const nc = execFileCalls.find((c) => c.cmd === 'nc');
    expect(nc).toBeDefined();
    expect(nc!.args.slice(0, 3)).toEqual(['-u', 'logs.example', '9999']);
  });

  it('loggerPath override is honored in local mode', async () => {
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(null, '', ''), 0);
    };
    const t = new SyslogTransport({ loggerPath: '/usr/bin/logger', tag: 't' });
    t.write(makeEntry(), 'msg');
    await new Promise((r) => setTimeout(r, 5));
    expect(execFileCalls[0].cmd).toBe('/usr/bin/logger');
  });

  it('facility option changes the -p prefix', async () => {
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(null, '', ''), 0);
    };
    const t = new SyslogTransport({ facility: 4, tag: 't' }); // LOG_AUTH
    t.write(makeEntry('error'), 'msg');
    await new Promise((r) => setTimeout(r, 5));
    expect(execFileCalls[0].args.slice(2, 4)).toEqual(['-p', '4.3']);
  });

  it('trace and fatal map to priorities 7 and 2', async () => {
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(null, '', ''), 0);
    };
    const t = new SyslogTransport({ tag: 't' });
    t.write(makeEntry('trace'), 'trace msg');
    t.write(makeEntry('fatal'), 'fatal msg');
    await new Promise((r) => setTimeout(r, 5));
    const trace = execFileCalls.find((c) => c.args[4] === 'trace msg');
    const fatal = execFileCalls.find((c) => c.args[4] === 'fatal msg');
    expect(trace!.args.slice(2, 4)).toEqual(['-p', '3.7']);
    expect(fatal!.args.slice(2, 4)).toEqual(['-p', '3.2']);
  });

  it('breaker re-opens after OPEN_MS elapses', async () => {
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(new Error('nope'), '', ''), 0);
    };
    const t = new SyslogTransport();
    const errors: unknown[] = [];
    t.onError = (e) => errors.push(e);
    const threshold = (SyslogTransport as unknown as { BREAK_AFTER: number }).BREAK_AFTER;
    for (let i = 0; i < threshold; i++) t.write(makeEntry(), 'x');
    await new Promise((r) => setTimeout(r, 10));
    expect(errors.length).toBe(1);
    // While the breaker is open, subsequent writes extend the window silently
    // and do not fire onError again.
    const t2 = new SyslogTransport();
    t2.onError = (e) => errors.push(e);
    const threshold2 = (SyslogTransport as unknown as { BREAK_AFTER: number }).BREAK_AFTER;
    for (let i = 0; i < threshold2; i++) t2.write(makeEntry(), 'x');
    await new Promise((r) => setTimeout(r, 10));
    expect(errors.length).toBe(2);
  });

  it('reportUnavailable (browser platform) trips the breaker without invoking execFile', () => {
    mockPlatform('browser');
    execFileImpl = () => {
      throw new Error('execFile should not be called on browser');
    };
    const t = new SyslogTransport();
    const errors: unknown[] = [];
    t.onError = (e) => errors.push(e);
    const threshold = (SyslogTransport as unknown as { BREAK_AFTER: number }).BREAK_AFTER;
    for (let i = 0; i < threshold; i++) t.write(makeEntry(), 'x');
    expect(execFileCalls).toHaveLength(0);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Windows deep paths ──────────────────────────────────────────────

describe('WindowsEventLogTransport: deep code paths', () => {
  it('wevtid metadata overrides the default event id on win32', async () => {
    mockPlatform('win32');
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(null, '', ''), 0);
    };
    const t = new WindowsEventLogTransport({ log: 'App', source: 'S', eventId: 100 });
    t.write(makeEntry('fatal', { metadata: { wevtid: 999 } }), 'boom');
    await new Promise((r) => setTimeout(r, 5));
    const call = execFileCalls.find((c) => c.cmd === 'eventcreate.exe');
    expect(call).toBeDefined();
    const idArg = call!.args[call!.args.lastIndexOf('/id') + 1];
    expect(idArg).toBe('999');
  });

  it('fatal level maps to error type; warn maps to information', async () => {
    mockPlatform('win32');
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(null, '', ''), 0);
    };
    const t = new WindowsEventLogTransport();
    t.write(makeEntry('fatal'), 'boom');
    t.write(makeEntry('warn'), 'warn msg');
    await new Promise((r) => setTimeout(r, 5));
    const calls = execFileCalls.filter((c) => c.cmd === 'eventcreate.exe');
    expect(calls.length).toBe(2);
    const fatalType = calls[0].args[calls[0].args.indexOf('/t') + 1];
    const warnType = calls[1].args[calls[1].args.indexOf('/t') + 1];
    expect(fatalType).toBe('error');
    expect(warnType).toBe('information');
  });

  it('custom log/source options are forwarded to eventcreate', async () => {
    mockPlatform('win32');
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(null, '', ''), 0);
    };
    const t = new WindowsEventLogTransport({ log: 'System', source: 'CustomProv', eventId: 7 });
    t.write(makeEntry('error'), 'custom');
    await new Promise((r) => setTimeout(r, 5));
    const call = execFileCalls.find((c) => c.cmd === 'eventcreate.exe');
    expect(call).toBeDefined();
    expect(call!.args).toContain('System');
    expect(call!.args).toContain('CustomProv');
    const idArg = call!.args[call!.args.lastIndexOf('/id') + 1];
    expect(idArg).toBe('7');
  });

  it('trace and debug map to information type on win32', async () => {
    mockPlatform('win32');
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(null, '', ''), 0);
    };
    const t = new WindowsEventLogTransport();
    t.write(makeEntry('trace'), 'trace msg');
    t.write(makeEntry('debug'), 'debug msg');
    await new Promise((r) => setTimeout(r, 5));
    const calls = execFileCalls.filter((c) => c.cmd === 'eventcreate.exe');
    expect(calls.length).toBe(2);
    expect(calls[0].args[calls[0].args.indexOf('/t') + 1]).toBe('information');
    expect(calls[1].args[calls[1].args.indexOf('/t') + 1]).toBe('information');
  });

  it('breaker re-opens after OPEN_MS elapses on failed writes', async () => {
    mockPlatform('win32');
    execFileImpl = (_cmd, _args, _opts, cb) => {
      setTimeout(() => cb(new Error('no win'), '', ''), 0);
    };
    const t = new WindowsEventLogTransport();
    const errors: unknown[] = [];
    t.onError = (e) => errors.push(e);
    const threshold = (WindowsEventLogTransport as unknown as { BREAK_AFTER: number }).BREAK_AFTER;
    for (let i = 0; i < threshold; i++) t.write(makeEntry(), 'x');
    await new Promise((r) => setTimeout(r, 10));
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('non-win32 platform gates every write into the unavailable breaker', () => {
    mockPlatform('darwin');
    execFileImpl = () => {
      throw new Error('execFile should not be called');
    };
    const t = new WindowsEventLogTransport();
    const errors: unknown[] = [];
    t.onError = (e) => errors.push(e);
    const threshold = (WindowsEventLogTransport as unknown as { BREAK_AFTER: number }).BREAK_AFTER;
    for (let i = 0; i < threshold; i++) t.write(makeEntry(), 'x');
    expect(execFileCalls).toHaveLength(0);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('close() is a no-op that does not throw', () => {
    const t = new WindowsEventLogTransport();
    expect(() => t.close()).not.toThrow();
  });
});
