import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleTransport } from '../src/transport/console.js';
import { FileTransport } from '../src/transport/file.js';
import { ElectronIpcTransport } from '../src/transport/electron-ipc.js';
import { createJsonFormatter } from '../src/pipeline/formatter.js';
import type { LogEntry } from '../src/types.js';
import { LOG_LEVELS } from '../src/types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    level: LOG_LEVELS.info,
    levelName: 'info',
    message: 'hello',
    args: [{ a: 1 }],
    timestamp: 1_700_000_000_000,
    time: new Date(1_700_000_000_000).toISOString(),
    context: { user: 'alice' },
    metadata: {},
    ...over,
  };
}

describe('ConsoleTransport', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes a line-formatted message via the info method', () => {
    const calls: unknown[] = [];
    const t = new ConsoleTransport({ methodMap: { info: (s) => void calls.push(s) } });
    t.write(makeEntry(), t.formatter(makeEntry()));
    expect(calls).toHaveLength(1);
    expect(String(calls[0])).toContain('hello');
  });

  it('maps fatal to console.error', () => {
    const calls: unknown[] = [];
    const t = new ConsoleTransport({ methodMap: { fatal: (s) => void calls.push(s) } });
    t.write(makeEntry({ levelName: 'fatal', level: LOG_LEVELS.fatal }), 'x');
    expect(calls).toHaveLength(1);
  });

  it('honors a custom formatter', () => {
    const calls: unknown[] = [];
    const t = new ConsoleTransport({
      formatter: () => 'CUSTOM',
      methodMap: { info: (s) => void calls.push(s) },
    });
    t.write(makeEntry(), t.formatter(makeEntry()));
    expect(calls[0]).toBe('CUSTOM');
  });

  it('routes error and fatal to the error method by default', () => {
    const calls: Record<string, unknown[]> = {};
    const capture = (lvl: string) => (s: unknown) => void (calls[lvl] ??= []).push(s);
    // The default `methodMap` maps both `error` and `fatal` to `console.error`.
    // Override them with a shared capture so we can assert they share the
    // stderr method without reaching into the real `console`.
    const t = new ConsoleTransport({
      methodMap: {
        trace: capture('trace'),
        debug: capture('debug'),
        info: capture('info'),
        warn: capture('warn'),
        error: capture('error'),
        fatal: capture('error'),
      },
    });
    t.write(makeEntry({ levelName: 'error', level: LOG_LEVELS.error }), 'e');
    t.write(makeEntry({ levelName: 'fatal', level: LOG_LEVELS.fatal }), 'f');
    expect(calls.error).toHaveLength(2); // both error and fatal route to error
  });

  it('routes extra levels to stderr via stderrLevels', () => {
    const calls: Record<string, unknown[]> = {};
    const capture = (lvl: string) => (s: unknown) => void (calls[lvl] ??= []).push(s);
    const t = new ConsoleTransport({
      stderrLevels: ['warn'],
      methodMap: {
        trace: capture('trace'),
        debug: capture('debug'),
        info: capture('info'),
        warn: capture('warn'),
        error: capture('error'),
        fatal: capture('fatal'),
      },
    });
    // Levels we did NOT list still use their `methodMap` entry.
    t.write(makeEntry({ levelName: 'info', level: LOG_LEVELS.info }), 'i');
    expect(calls.info).toHaveLength(1);
    // `warn` is remapped to `console.error` (real stderr) by `stderrLevels`,
    // which overrides the `methodMap` entry — so the `warn` capture is never
    // hit and the entry is routed to stderr instead.
    t.write(makeEntry({ levelName: 'warn', level: LOG_LEVELS.warn }), 'w');
    expect(calls.warn).toBeUndefined();
  });
});

describe('FileTransport (single mode)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elog-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends JSON lines and can be flushed/closed', async () => {
    const file = join(dir, 'app.log');
    const t = new FileTransport({
      mode: 'single',
      appName: 'app',
      dir,
      ext: 'log',
      formatter: createJsonFormatter(),
    });
    t.write(makeEntry({ message: 'one' }), t.formatter(makeEntry({ message: 'one' })));
    t.write(makeEntry({ message: 'two' }), t.formatter(makeEntry({ message: 'two' })));
    await t.close();

    const content = await readFile(file, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).message).toBe('one');
    expect(JSON.parse(lines[1]).message).toBe('two');
  });

  it('writes in order under concurrency (buffered queue)', async () => {
    const file = join(dir, 'order.log');
    const t = new FileTransport({ mode: 'single', appName: 'order', dir, ext: 'log' });
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      writes.push(Promise.resolve(t.write(makeEntry({ message: String(i) }), `line-${i}`)));
    }
    await Promise.all(writes);
    await t.close();

    const content = await readFile(file, 'utf8');
    const lines = content.trim().split('\n');
    for (let i = 0; i < 50; i++) {
      expect(lines[i]).toBe(`line-${i}`);
    }
  });
});

describe('FileTransport (rotate-time mode)', () => {
  let dir: string;
  let clock: Date;
  const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 0, 0, 0, 0);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elog-d-'));
    clock = day(2024, 1, 1);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes to a dated file by default', async () => {
    const t = new FileTransport({
      mode: 'rotate-time',
      unit: 'day',
      appName: 'app',
      dir,
      now: () => clock,
    });
    const e = makeEntry({ message: 'one' });
    t.write(e, t.formatter(e));
    await t.close();
    const content = (await readFile(join(dir, 'app.2024-01-01.0.log'), 'utf8')).trim();
    expect(content.split('\n')).toHaveLength(1);
    expect(JSON.parse(content).message).toBe('one');
  });

  it('opens a new dated file on a new day, keeping the previous day file', async () => {
    const t = new FileTransport({
      mode: 'rotate-time',
      unit: 'day',
      appName: 'app',
      dir,
      now: () => clock,
    });
    const d1 = makeEntry({ message: 'd1' });
    await t.write(d1, t.formatter(d1));
    clock = day(2024, 1, 2);
    const d2 = makeEntry({ message: 'd2' });
    await t.write(d2, t.formatter(d2));
    await t.close();

    const c1 = (await readFile(join(dir, 'app.2024-01-01.0.log'), 'utf8')).trim();
    const c2 = (await readFile(join(dir, 'app.2024-01-02.0.log'), 'utf8')).trim();
    expect(c1).toContain('d1');
    expect(c2).toContain('d2');
  });
});

describe('ConsoleTransport - methodMap', () => {
  it('uses the provided methodMap for known levels', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const custom = new ConsoleTransport({ methodMap: { info: console.info } });
    custom.write(makeEntry({ levelName: 'info' }), 'info-line');
    expect(spy).toHaveBeenCalledWith('info-line');
    spy.mockRestore();
  });
});

describe('FileTransport (rotate-size mode)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elog-size-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rotates generations when maxSize is exceeded', async () => {
    const file = join(dir, 'app.log');
    const t = new FileTransport({
      mode: 'rotate-size',
      appName: 'app',
      dir,
      ext: 'log',
      maxSize: 10,
      maxFiles: 3,
    });
    for (let i = 0; i < 5; i++) {
      const e = makeEntry({ message: `m${i}` });
      t.write(e, t.formatter(e));
    }
    await t.close();

    expect((await readFile(file, 'utf8')).trim()).toContain('m4');
    expect((await readFile(join(dir, 'app.1.log'), 'utf8')).trim()).toContain('m3');
    expect((await readFile(join(dir, 'app.2.log'), 'utf8')).trim()).toContain('m2');
  });

  it('clamps size-mode maxFiles to >= 2', async () => {
    const file = join(dir, 'clamp.log');
    const t = new FileTransport({
      mode: 'rotate-size',
      appName: 'clamp',
      dir,
      ext: 'log',
      maxSize: 1,
      maxFiles: 1,
    });
    const a = makeEntry({ message: 'a' });
    t.write(a, t.formatter(a));
    const b = makeEntry({ message: 'b' });
    t.write(b, t.formatter(b));
    const c = makeEntry({ message: 'c' });
    t.write(c, t.formatter(c));
    await t.close();
    expect((await readFile(file, 'utf8')).trim()).toContain('c');
    expect((await readFile(join(dir, 'clamp.1.log'), 'utf8')).trim()).toContain('b');
  });
});

describe('ElectronIpcTransport - safe in non-electron env', () => {
  it('does not throw when electron is unavailable', () => {
    const t = new ElectronIpcTransport();
    expect(() => t.write(makeEntry())).not.toThrow();
  });
});

describe('ElectronIpcTransport - injected ipcRenderer', () => {
  it('forwards entries via an injected sender without requiring electron', () => {
    const sent: Array<[string, unknown]> = [];
    const ipcRenderer = { send: (channel: string, data: unknown) => sent.push([channel, data]) };
    const t = new ElectronIpcTransport({ channel: 'test:log', ipcRenderer });
    const entry = makeEntry({ message: 'bridge' });
    t.write(entry);
    expect(sent).toEqual([['test:log', entry]]);
  });

  it('prefers the injected sender over the ambient electron module', () => {
    const sent: Array<[string, unknown]> = [];
    const ipcRenderer = { send: (channel: string, data: unknown) => sent.push([channel, data]) };
    const t = new ElectronIpcTransport({ ipcRenderer });
    t.write(makeEntry({ message: 'a' }));
    t.write(makeEntry({ message: 'b' }));
    expect(sent).toHaveLength(2);
  });

  it('derives its name from the channel', () => {
    const t = new ElectronIpcTransport({
      channel: 'my:chan',
      ipcRenderer: { send: () => {} },
    });
    expect(t.name).toBe('ipc:my:chan');
  });
});
