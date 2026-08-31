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
import { mkdir, utimes } from 'node:fs/promises';
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
    expect(readFileSync(join(dir, 'day.2024-01-01.0.log'), 'utf8')).toContain('d1');
    expect(readFileSync(join(dir, 'day.2024-01-02.0.log'), 'utf8')).toContain('d2');
  });

  it('honors a custom fileName', async () => {
    const t = new FileTransport({
      mode: 'rotate-time',
      unit: 'day',
      appName: 'day',
      dir,
      ext: 'log',
      now: () => new Date(2024, 2, 3),
      fileName: (app, stamp, _seq, ext) => `${app}_${stamp}.${ext}`,
    });
    t.write(entry('x'), 'x');
    await t.flush();
    await t.close();
    expect(readFileSync(join(dir, 'day_2024-03-03.log'), 'utf8')).toContain('x');
  });

  it('adopts the most recent existing bucket file on (re)start', async () => {
    // Simulate a previous run that left a dated file on disk.
    writeFileSync(join(dir, 'restart.2024-01-01.0.log'), 'old day\n');
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
    expect(readFileSync(join(dir, 'restart.2024-01-01.0.log'), 'utf8')).toContain('new');
    expect(readFileSync(join(dir, 'restart.2024-01-01.0.log'), 'utf8')).toContain('old day');
  });

  it('splits within a time bucket when maxSize is exceeded', async () => {
    const clock = { now: new Date(2024, 0, 1) };
    const t = new FileTransport({
      mode: 'rotate-time',
      unit: 'day',
      appName: 'sz',
      dir,
      ext: 'log',
      maxSize: 8, // each entry is 3 bytes ('m1\n') → fits 2 entries per file
      now: () => clock.now,
    });
    t.write(entry('m1'), 'm1');
    t.write(entry('m2'), 'm2');
    t.write(entry('m3'), 'm3'); // triggers split
    await t.flush();
    await t.close();
    // First bucket file should have the first 2 entries
    const file0 = readFileSync(join(dir, 'sz.2024-01-01.0.log'), 'utf8');
    expect(file0).toContain('m1');
    expect(file0).toContain('m2');
    // Second bucket file should have the third entry
    const file1 = readFileSync(join(dir, 'sz.2024-01-01.1.log'), 'utf8');
    expect(file1).toContain('m3');
  });

  it('resets seq when the time bucket changes with maxSize', async () => {
    const clock = { now: new Date(2024, 0, 1) };
    const t = new FileTransport({
      mode: 'rotate-time',
      unit: 'day',
      appName: 'seq',
      dir,
      ext: 'log',
      maxSize: 8,
      now: () => clock.now,
    });
    t.write(entry('a1'), 'a1');
    t.write(entry('a2'), 'a2');
    t.write(entry('a3'), 'a3'); // split → seq.2024-01-01.1.log
    clock.now = new Date(2024, 0, 2);
    t.write(entry('b1'), 'b1'); // new day → seq.2024-01-02.0.log (seq resets)
    await t.flush();
    await t.close();
    expect(existsSync(join(dir, 'seq.2024-01-01.0.log'))).toBe(true);
    expect(existsSync(join(dir, 'seq.2024-01-01.1.log'))).toBe(true);
    expect(existsSync(join(dir, 'seq.2024-01-02.0.log'))).toBe(true);
    expect(readFileSync(join(dir, 'seq.2024-01-02.0.log'), 'utf8')).toContain('b1');
  });
  it('trims entire oldest time buckets (not individual files) when maxFiles is set', async () => {
    const clock = { now: new Date(2026, 7, 1) }; // Aug 1
    const t = new FileTransport({
      mode: 'rotate-time',
      unit: 'day',
      appName: 'tb',
      dir,
      ext: 'log',
      maxSize: 8, // ~2 entries per file → forces splitting
      maxFiles: 2, // keep 2 time buckets
      now: () => clock.now,
    });
    // Day 1 — two entries, then split on third → 2 files for day 1
    t.write(entry('a1'), 'a1');
    t.write(entry('a2'), 'a2');
    t.write(entry('a3'), 'a3'); // split → tb.2026-08-01.1.log
    // Day 2 — one entry
    clock.now = new Date(2026, 7, 2);
    t.write(entry('b1'), 'b1');
    // Day 3 — triggers trimTimeRing; day 1 should be fully removed
    clock.now = new Date(2026, 7, 3);
    t.write(entry('c1'), 'c1');
    await t.flush();
    await t.close();
    // Day 1 (oldest bucket) — both seq files deleted
    expect(existsSync(join(dir, 'tb.2026-08-01.0.log'))).toBe(false);
    expect(existsSync(join(dir, 'tb.2026-08-01.1.log'))).toBe(false);
    // Day 2 and Day 3 kept
    expect(existsSync(join(dir, 'tb.2026-08-02.0.log'))).toBe(true);
    expect(existsSync(join(dir, 'tb.2026-08-03.0.log'))).toBe(true);
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

describe('FileTransport - global capacity caps (maxTotalSize / maxAge)', () => {
  const base = mkdtempSync(join(tmpdir(), 'lograil-caps-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  // Caps only matter for rotating modes (they produce multiple files). For
  // `single` (one file, no rotation) the per-file size is governed by
  // `maxSize`/truncation instead, so caps are intentionally a no-op there.

  it('deletes the oldest history files when total size exceeds maxTotalSize (rotate-size)', async () => {
    const dir = join(base, 'size');
    await mkdir(dir, { recursive: true });
    // Three stale 50-byte history files (non-numeric suffixes so the
    // rotation rename chain leaves them untouched), oldest first by mtime.
    for (const [i, name] of ['old1', 'old2', 'old3'].entries()) {
      const p = join(dir, `cap.${name}.log`);
      writeFileSync(p, 'x'.repeat(50));
      const t0 = new Date(2020, 0, 1, 0, 0, i + 1);
      await utimes(p, t0, t0);
    }
    const t = new FileTransport({
      mode: 'rotate-size',
      appName: 'cap',
      dir,
      ext: 'log',
      maxSize: 2, // every entry (3 bytes) exceeds this → rotates each write
      maxFiles: 100, // let maxTotalSize be the only trimming authority
      maxTotalSize: 105, // active(~4B) + 3×3B + 3×50B = 163 > 105 → drop cap.10 & cap.11
    });
    for (let i = 0; i < 3; i++) t.write(entry(`m${i}`), `m${i}`);
    await t.flush();
    await t.close();
    // The active file (cap.log) is never deleted and counts toward the cap, so
    // the two oldest stale history files are dropped; the newest stale one
    // (cap.old3.log) plus the freshly rotated generations survive.
    expect(existsSync(join(dir, 'cap.old1.log'))).toBe(false); // oldest → purged
    expect(existsSync(join(dir, 'cap.old2.log'))).toBe(false); // 2nd oldest → purged
    expect(existsSync(join(dir, 'cap.old3.log'))).toBe(true); // newest stale → kept
    expect(readdirSync(dir)).toContain('cap.log');
  });

  it('deletes files older than maxAge, keeping the active file (rotate-size)', async () => {
    const dir = join(base, 'age');
    await mkdir(dir, { recursive: true });
    const oldPath = join(dir, 'age.old.log');
    writeFileSync(oldPath, 'stale');
    const old = new Date(2020, 0, 1);
    await utimes(oldPath, old, old);
    const t = new FileTransport({
      mode: 'rotate-size',
      appName: 'age',
      dir,
      ext: 'log',
      maxSize: 2,
      maxFiles: 100,
      maxAge: 1000, // anything older than ~1s is purged
    });
    for (let i = 0; i < 2; i++) t.write(entry(`m${i}`), `m${i}`);
    await t.flush();
    await t.close();
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(join(dir, 'age.log'))).toBe(true);
  });

  it('never deletes the active file even if it is the oldest', async () => {
    const dir = join(base, 'active');
    await mkdir(dir, { recursive: true });
    const t = new FileTransport({
      mode: 'rotate-size',
      appName: 'act',
      dir,
      ext: 'log',
      maxSize: 2,
      maxFiles: 100,
      maxAge: 1, // aggressive: only the just-written active file survives
    });
    for (let i = 0; i < 2; i++) t.write(entry(`m${i}`), `m${i}`);
    await t.flush();
    // touch the active file old, then trigger another rotation via a write
    const ap = join(dir, 'act.log');
    const old = new Date(2020, 0, 1);
    await utimes(ap, old, old);
    t.write(entry('again'), 'again');
    await t.flush();
    await t.close();
    expect(existsSync(ap)).toBe(true);
  });

  it('is a no-op for single mode (per-file size is governed by maxSize instead)', async () => {
    const dir = join(base, 'single');
    await mkdir(dir, { recursive: true });
    // A stale file that would be deleted under a rotating mode.
    const stale = join(dir, 'sg.1.log');
    writeFileSync(stale, 'x'.repeat(50));
    await utimes(stale, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const t = new FileTransport({
      mode: 'single',
      appName: 'sg',
      dir,
      ext: 'log',
      maxTotalSize: 10, // tiny, but irrelevant for single mode
      maxAge: 1,
    });
    t.write(entry('new'), 'new');
    await t.flush();
    await t.close();
    // Single mode never rotates, so the periodic cap check is throttled and the
    // stale history file is left intact (caps target rotating-mode file sets).
    expect(existsSync(stale)).toBe(true);
    expect(existsSync(join(dir, 'sg.log'))).toBe(true);
  });

  it('keeps everything when no caps are set', async () => {
    const dir = join(base, 'none');
    await mkdir(dir, { recursive: true });
    for (let i = 1; i <= 3; i++) writeFileSync(join(dir, `nc.${i}.log`), 'data');
    const t = new FileTransport({ mode: 'single', appName: 'nc', dir, ext: 'log' });
    t.write(entry('new'), 'new');
    await t.flush();
    await t.close();
    expect(readdirSync(dir).filter((f) => f.startsWith('nc.') && f !== 'nc.log')).toHaveLength(3);
  });
});
