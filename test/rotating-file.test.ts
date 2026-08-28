import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { RotatingFileTransport } from '../src/transport/rotating-file.js';
import type { LogEntry } from '../src/types.js';

function tmpFile(name: string): string {
  return join(tmpdir(), `lograil-test-${process.pid}-${name}`);
}

function entry(message: string): LogEntry {
  return {
    level: 30,
    levelName: 'info',
    message,
    args: [],
    timestamp: 1,
    time: new Date(1).toISOString(),
    context: {},
    metadata: {},
  };
}

const created: string[] = [];

afterEach(() => {
  // Sweep every file this process created in tmpdir (active, generations,
  // and dated daily files all share the test prefix).
  try {
    const dir = tmpdir();
    for (const f of readdirSync(dir)) {
      if (f.startsWith(`lograil-test-${process.pid}-`)) {
        try {
          rmSync(join(dir, f), { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  created.length = 0;
});

describe('RotatingFileTransport', () => {
  it('writes entries to the active file', async () => {
    const path = tmpFile('plain.log');
    created.push(path);
    const t = new RotatingFileTransport({ path, maxSize: 1024, maxFiles: 3, daily: false });
    t.write(entry('a'), 'a');
    t.write(entry('b'), 'b');
    await t.flush();
    await t.close();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('a\nb\n');
  });

  it('rotates and keeps up to maxFiles generations', async () => {
    const path = tmpFile('rotate.log');
    created.push(path);
    // 6 bytes per line ("x\n" plus message). maxSize=5 forces a rotation
    // roughly every line; maxFiles=3 keeps active + 2 generations.
    const t = new RotatingFileTransport({ path, maxSize: 5, maxFiles: 3, daily: false });
    for (let i = 0; i < 6; i++) {
      t.write(entry(`m${i}`), `m${i}`);
    }
    await t.flush();
    await t.close();

    // active file holds the latest entry
    expect(readFileSync(path, 'utf8')).toContain('m5');

    // generations exist and oldest beyond maxFiles is pruned
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(true);
    expect(existsSync(`${path}.3`)).toBe(false);

    // only the most recent `maxFiles` entries survive; the rest are pruned
    const gen2 = readFileSync(`${path}.2`, 'utf8');
    expect(gen2).toContain('m3');
    const all = [path, `${path}.1`, `${path}.2`].map((f) => readFileSync(f, 'utf8')).join('');
    expect(all).not.toContain('m0');
    expect(all).not.toContain('m1');
    expect(all).not.toContain('m2');
  });

  it('continues appending to the same active file below the limit', async () => {
    const path = tmpFile('nogrow.log');
    created.push(path);
    const t = new RotatingFileTransport({ path, maxSize: 1024, maxFiles: 3, daily: false });
    for (let i = 0; i < 3; i++) t.write(entry(`l${i}`), `l${i}`);
    await t.flush();
    await t.close();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toEqual(['l0', 'l1', 'l2']);
    expect(
      readdirSync(tmpdir()).filter((f) => f.startsWith(`lograil-test-${process.pid}-nogrow`)),
    ).toHaveLength(1);
  });
});

describe('RotatingFileTransport (daily)', () => {
  const clock = { d: new Date('2026-08-27T10:00:00') };
  const now = (): Date => clock.d;
  // New format: {name}.{YYYY-MM-DD}.{index}.log
  const dated = (path: string, date: string, idx: string): string => {
    const ext = extname(path);
    const base = ext ? path.slice(0, -ext.length) : path;
    return `${base}.${date}.${idx}${ext}`;
  };

  it('uses name.date.index.log and wraps index at 99, clearing 01', async () => {
    clock.d = new Date('2026-08-27T10:00:00');
    const path = tmpFile('wrap.log');
    created.push(path);
    // maxSize=1 forces a new index file on (almost) every write.
    const t = new RotatingFileTransport({ path, daily: true, maxSize: 1, now });

    for (let i = 0; i < 100; i++) {
      t.write(entry(`m${i}`), `m${i}`);
    }
    await t.flush();
    await t.close();

    expect(existsSync(dated(path, '2026-08-27', '01'))).toBe(true);
    expect(existsSync(dated(path, '2026-08-27', '99'))).toBe(true);
    // index never exceeds 99
    expect(existsSync(dated(path, '2026-08-27', '100'))).toBe(false);

    // On wrap, 01 was cleared and now holds only the last entry (m99).
    const one = readFileSync(dated(path, '2026-08-27', '01'), 'utf8');
    expect(one).toContain('m99');
    expect(one).not.toContain('m0');
    // The 99th slot holds m98.
    expect(readFileSync(dated(path, '2026-08-27', '99'), 'utf8')).toContain('m98');
  });

  it('resets index to 01 on a new day and keeps previous day files', async () => {
    const path = tmpFile('day.log');
    created.push(path);
    const t = new RotatingFileTransport({ path, daily: true, maxSize: 1, now });

    clock.d = new Date('2026-08-27T10:00:00');
    t.write(entry('a'), 'a');
    await t.flush();
    clock.d = new Date('2026-08-28T10:00:00');
    t.write(entry('b'), 'b');
    await t.flush();
    await t.close();

    expect(existsSync(dated(path, '2026-08-27', '01'))).toBe(true);
    expect(existsSync(dated(path, '2026-08-28', '01'))).toBe(true);
    expect(readFileSync(dated(path, '2026-08-28', '01'), 'utf8')).toContain('b');
  });

  it('honors maxFiles as the per-day index cap', async () => {
    clock.d = new Date('2026-08-27T10:00:00');
    const path = tmpFile('cap.log');
    created.push(path);
    // maxFiles=3 -> indexes run 01..03, then wrap to 01 (clear) on the 4th.
    const t = new RotatingFileTransport({ path, daily: true, maxSize: 1, now, maxFiles: 3 });

    for (let i = 0; i < 5; i++) {
      t.write(entry(`m${i}`), `m${i}`);
    }
    await t.flush();
    await t.close();

    expect(existsSync(dated(path, '2026-08-27', '01'))).toBe(true);
    expect(existsSync(dated(path, '2026-08-27', '02'))).toBe(true);
    expect(existsSync(dated(path, '2026-08-27', '03'))).toBe(true);
    expect(existsSync(dated(path, '2026-08-27', '04'))).toBe(false);

    // Wrapped past 03: 01 was cleared (holds m3, not m0); 02 holds m4.
    const one = readFileSync(dated(path, '2026-08-27', '01'), 'utf8');
    expect(one).toContain('m3');
    expect(one).not.toContain('m0');
    expect(readFileSync(dated(path, '2026-08-27', '02'), 'utf8')).toContain('m4');
    expect(readFileSync(dated(path, '2026-08-27', '03'), 'utf8')).toContain('m2');
  });
});
