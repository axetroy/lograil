import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTransport, createLineFormatter } from '../src/index.js';

function entry(message: string): never {
  return { levelName: 'info', message } as never;
}

describe('FileTransport - single mode (1.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lograil-single-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('appends forever to one fixed file (no rotation)', async () => {
    const t = new FileTransport({ mode: 'single', appName: 'app', dir, ext: 'log' });
    for (let i = 0; i < 5; i++) t.write(entry(`m${i}`), `m${i}`);
    await t.flush();
    await t.close();
    const text = readFileSync(join(dir, 'app.log'), 'utf8');
    expect(text.trim().split('\n')).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    // single mode keeps exactly one file
    expect(readdirSync(dir).filter((f) => f.startsWith('app'))).toHaveLength(1);
  });

  it('drops entries rejected by the filter', async () => {
    const t = new FileTransport({
      mode: 'single',
      appName: 'filt',
      dir,
      ext: 'log',
      filter: (e) => (e as { levelName: string }).levelName !== 'debug',
    });
    t.write(entry('drop'), 'drop');
    t.write(entry('keep'), 'keep');
    await t.flush();
    await t.close();
    expect(readFileSync(join(dir, 'filt.log'), 'utf8')).toContain('keep');
  });
});

describe('FileTransport - single-truncate mode (1.2)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lograil-strunc-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('backs up and truncates once maxSize would be exceeded', async () => {
    const t = new FileTransport({
      mode: 'single-truncate',
      appName: 'ring',
      dir,
      ext: 'log',
      maxSize: 8,
    });
    for (let i = 1; i <= 10; i++) t.write(entry(String(i)), String(i));
    await t.flush();
    await t.close();

    const size = statSync(join(dir, 'ring.log')).size;
    expect(size).toBeLessThanOrEqual(8);
    const text = readFileSync(join(dir, 'ring.log'), 'utf8');
    expect(text).not.toContain('1\n');
    expect(text).toContain('10\n');
    // backup file exists (default `${appName}.bak`)
    expect(existsSync(join(dir, 'ring.bak'))).toBe(true);
  });

  it('honors a custom backupName', async () => {
    const t = new FileTransport({
      mode: 'single-truncate',
      appName: 'ring2',
      dir,
      ext: 'log',
      maxSize: 8,
      backupName: 'ring2.backup',
    });
    for (let i = 1; i <= 6; i++) t.write(entry(String(i)), String(i));
    await t.flush();
    await t.close();
    expect(existsSync(join(dir, 'ring2.backup'))).toBe(true);
  });

  it('truncates even when a stale backup already exists', async () => {
    // Pre-create a backup (simulates a previous run / Windows where rename
    // refuses to overwrite). The transport must remove it before backing up.
    writeFileSync(join(dir, 'ring3.bak'), 'old backup content');
    const t = new FileTransport({
      mode: 'single-truncate',
      appName: 'ring3',
      dir,
      ext: 'log',
      maxSize: 8,
      backupName: 'ring3.bak',
    });
    for (let i = 1; i <= 10; i++) t.write(entry(String(i)), String(i));
    await t.flush();
    await t.close();
    // active file was reset to a fresh, small size (truncation happened)
    const size = statSync(join(dir, 'ring3.log')).size;
    expect(size).toBeLessThanOrEqual(8);
    expect(readFileSync(join(dir, 'ring3.log'), 'utf8')).toContain('10\n');
    // backup holds the pre-truncation content, not the stale string
    expect(readFileSync(join(dir, 'ring3.bak'), 'utf8')).not.toContain('old backup content');
  });
});

describe('FileTransport - rotate-size mode (2.1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lograil-rsize-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('rolls into N generations and prunes oldest beyond maxFiles', async () => {
    const t = new FileTransport({
      mode: 'rotate-size',
      appName: 'sz',
      dir,
      ext: 'log',
      maxSize: 5,
      maxFiles: 3,
    });
    for (let i = 0; i < 6; i++) t.write(entry(`m${i}`), `m${i}`);
    await t.flush();
    await t.close();

    expect(readFileSync(join(dir, 'sz.log'), 'utf8')).toContain('m5');
    expect(readFileSync(join(dir, 'sz.1.log'), 'utf8')).toContain('m4');
    expect(readFileSync(join(dir, 'sz.2.log'), 'utf8')).toContain('m3');
    // beyond maxFiles is pruned
    expect(existsSync(join(dir, 'sz.3.log'))).toBe(false);
  });

  it('honors a custom fileName', async () => {
    const t = new FileTransport({
      mode: 'rotate-size',
      appName: 'sz',
      dir,
      ext: 'log',
      maxSize: 5,
      maxFiles: 2,
      fileName: (app, i, ext) => `${app}-gen${i}.${ext}`,
    });
    for (let i = 0; i < 4; i++) t.write(entry(`m${i}`), `m${i}`);
    await t.flush();
    await t.close();
    expect(existsSync(join(dir, 'sz-gen1.log'))).toBe(true);
  });
});

describe('FileTransport - rotate-time mode (2.2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lograil-rtime-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('opens a new dated file on a new day, keeping the old one', async () => {
    const clock = { now: new Date(2024, 0, 1) };
    const t = new FileTransport({
      mode: 'rotate-time',
      unit: 'day',
      appName: 'day',
      dir,
      ext: 'log',
      now: () => clock.now,
    });
    t.write(entry('d1'), 'd1');
    clock.now = new Date(2024, 0, 2);
    t.write(entry('d2'), 'd2');
    await t.flush();
    await t.close();
    expect(readFileSync(join(dir, 'day.2024-01-01.log'), 'utf8')).toContain('d1');
    expect(readFileSync(join(dir, 'day.2024-01-02.log'), 'utf8')).toContain('d2');
  });

  it('honors a custom fileName', async () => {
    const t = new FileTransport({
      mode: 'rotate-time',
      unit: 'day',
      appName: 'day',
      dir,
      ext: 'log',
      now: () => new Date(2024, 2, 3),
      fileName: (app, stamp, ext) => `${app}_${stamp}.${ext}`,
    });
    t.write(entry('x'), 'x');
    await t.flush();
    await t.close();
    expect(readFileSync(join(dir, 'day_2024-03-03.log'), 'utf8')).toContain('x');
  });

  it('adopts the most recent existing bucket file on (re)start', async () => {
    // Simulate a previous run that left a dated file on disk.
    writeFileSync(join(dir, 'restart.2024-01-01.log'), 'old day\n');
    const t = new FileTransport({
      mode: 'rotate-time',
      unit: 'day',
      appName: 'restart',
      dir,
      ext: 'log',
      now: () => new Date(2024, 0, 1),
    });
    t.write(entry('new'), 'new');
    await t.flush();
    await t.close();
    // Continues writing into the existing bucket file, not a fresh one.
    expect(readFileSync(join(dir, 'restart.2024-01-01.log'), 'utf8')).toContain('new');
    expect(readFileSync(join(dir, 'restart.2024-01-01.log'), 'utf8')).toContain('old day');
  });
});

describe('FileTransport - rotate-custom mode (2.3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lograil-rcust-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('rotates whenever the user predicate returns true', async () => {
    const t = new FileTransport({
      mode: 'rotate-custom',
      appName: 'cus',
      dir,
      ext: 'log',
      shouldRotate: (e) => (e as { message: string }).message === 'cut',
      fileName: (app, i, ext) => `${app}.${i}.${ext}`,
    });
    t.write(entry('a'), 'a');
    t.write(entry('cut'), 'cut'); // triggers rotation
    t.write(entry('b'), 'b');
    await t.flush();
    await t.close();

    expect(readFileSync(join(dir, 'cus.0.log'), 'utf8')).toContain('a');
    expect(readFileSync(join(dir, 'cus.1.log'), 'utf8')).toContain('b');
  });
});

describe('FileTransport - construction', () => {
  it('requires an appName', () => {
    expect(() => new FileTransport({ mode: 'single' } as never)).toThrow(/appName/);
  });

  it('uses the provided formatter when given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lograil-fmt-'));
    const t = new FileTransport({
      mode: 'single',
      appName: 'fmt',
      dir,
      ext: 'log',
      formatter: createLineFormatter(),
    });
    t.write(entry('hi'), 'hi');
    await t.flush();
    await t.close();
    expect(readFileSync(join(dir, 'fmt.log'), 'utf8')).toContain('hi');
    rmSync(dir, { recursive: true, force: true });
  });
});
