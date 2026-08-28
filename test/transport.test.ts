import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConsoleTransport } from '../src/transport/console.js';
import { RotatingFileTransport } from '../src/transport/rotating-file.js';
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

  it('writes a line-formatted message to console.info', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const t = new ConsoleTransport();
    t.write(makeEntry(), t.formatter(makeEntry()));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('hello');
  });

  it('maps fatal to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = new ConsoleTransport();
    t.write(makeEntry({ levelName: 'fatal', level: LOG_LEVELS.fatal }), 'x');
    expect(spy).toHaveBeenCalled();
  });

  it('honors a custom formatter', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const t = new ConsoleTransport({ formatter: () => 'CUSTOM' });
    t.write(makeEntry(), t.formatter(makeEntry()));
    expect(spy.mock.calls[0][0]).toBe('CUSTOM');
  });
});

describe('RotatingFileTransport (no rotation, daily:false)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elog-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends JSON lines and can be flushed/closed', async () => {
    const file = join(dir, 'app.log');
    const t = new RotatingFileTransport({
      path: file,
      daily: false,
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
    const t = new RotatingFileTransport({ path: file, daily: false });
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

describe('RotatingFileTransport (daily mode)', () => {
  let dir: string;
  let clock: Date;
  const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 0, 0, 0, 0);
  const pathFor = (d: Date, idx: number) =>
    join(
      dir,
      `app.${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}.${String(idx).padStart(2, '0')}.log`,
    );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elog-d-'));
    clock = day(2024, 1, 1);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes to a dated index-01 file by default', async () => {
    const t = new RotatingFileTransport({
      path: join(dir, 'app.log'),
      now: () => clock,
      maxSize: 1 << 30,
      maxFiles: 99,
    });
    const e = makeEntry({ message: 'one' });
    t.write(e, t.formatter(e));
    await t.close();
    const content = (await readFile(pathFor(clock, 1), 'utf8')).trim();
    expect(content.split('\n')).toHaveLength(1);
    expect(JSON.parse(content).message).toBe('one');
  });

  it('resets to index 01 on a new day, keeping the previous day file', async () => {
    const t = new RotatingFileTransport({
      path: join(dir, 'app.log'),
      now: () => clock,
      maxSize: 1 << 30,
      maxFiles: 99,
    });
    const d1 = makeEntry({ message: 'd1' });
    await t.write(d1, t.formatter(d1));
    clock = day(2024, 1, 2);
    const d2 = makeEntry({ message: 'd2' });
    await t.write(d2, t.formatter(d2));
    await t.close();

    const c1 = (await readFile(pathFor(day(2024, 1, 1), 1), 'utf8')).trim();
    const c2 = (await readFile(pathFor(day(2024, 1, 2), 1), 'utf8')).trim();
    expect(c1).toContain('d1');
    expect(c2).toContain('d2');
  });

  it('wraps to index 01 and clears the stale 01 slot when maxFiles is exceeded', async () => {
    // Tiny maxSize => every write rotates; maxFiles=3 => 01,02,03 then wrap to 01.
    const t = new RotatingFileTransport({
      path: join(dir, 'app.log'),
      now: () => clock,
      maxSize: 10,
      maxFiles: 3,
    });
    for (const label of ['a', 'b', 'c', 'd']) {
      const e = makeEntry({ message: label });
      t.write(e, t.formatter(e));
    }
    await t.close();

    const c1 = (await readFile(pathFor(clock, 1), 'utf8')).trim().split('\n');
    const c2 = (await readFile(pathFor(clock, 2), 'utf8')).trim().split('\n');
    const c3 = (await readFile(pathFor(clock, 3), 'utf8')).trim().split('\n');
    // Only the 4th ('d') must remain in the wrapped 01 slot.
    expect(c1).toHaveLength(1);
    expect(JSON.parse(c1[0]).message).toBe('d');
    expect(JSON.parse(c2[0]).message).toBe('b');
    expect(JSON.parse(c3[0]).message).toBe('c');
  });

  it('daily mode with maxFiles=1 wraps to 01 and clears on the 2nd write', async () => {
    const t = new RotatingFileTransport({
      path: join(dir, 'app.log'),
      now: () => clock,
      maxSize: 10,
      maxFiles: 1,
    });
    const a = makeEntry({ message: 'a' });
    t.write(a, t.formatter(a));
    const b = makeEntry({ message: 'b' });
    t.write(b, t.formatter(b));
    await t.close();
    const lines = (await readFile(pathFor(clock, 1), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).message).toBe('b');
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

describe('RotatingFileTransport (size mode)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'elog-size-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rotates generations when maxSize is exceeded', async () => {
    const file = join(dir, 'app.log');
    const t = new RotatingFileTransport({ path: file, daily: false, maxSize: 10, maxFiles: 3 });
    for (let i = 0; i < 5; i++) {
      const e = makeEntry({ message: `m${i}` });
      t.write(e, t.formatter(e));
    }
    await t.close();

    expect((await readFile(file, 'utf8')).trim()).toContain('m4');
    expect((await readFile(`${file}.1`, 'utf8')).trim()).toContain('m3');
    expect((await readFile(`${file}.2`, 'utf8')).trim()).toContain('m2');
  });

  it('clamps size-mode maxFiles to >= 2', async () => {
    const file = join(dir, 'clamp.log');
    // maxFiles:1 is clamped to 2 at construction time.
    const t = new RotatingFileTransport({ path: file, daily: false, maxSize: 1, maxFiles: 1 });
    const a = makeEntry({ message: 'a' });
    t.write(a, t.formatter(a));
    const b = makeEntry({ message: 'b' });
    t.write(b, t.formatter(b));
    const c = makeEntry({ message: 'c' });
    t.write(c, t.formatter(c));
    await t.close();
    expect((await readFile(file, 'utf8')).trim()).toContain('c');
    expect((await readFile(`${file}.1`, 'utf8')).trim()).toContain('b');
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
