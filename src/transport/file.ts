import { mkdir, open, rename, rm, stat, readdir } from '../shims/index.js';
import { basename, dirname, join } from '../shims/index.js';
import { tmpdir } from '../shims/index.js';
import type { LogEntry } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';
import { createJsonFormatter } from '../pipeline/formatter.js';
import type { Transport } from './transport.js';

/** Fields every file mode shares. `appName` is required so the log file name
 * always embeds the application identity. */
export interface FileBaseOptions {
  /** Application name; embedded in every generated log file name. */
  appName: string;
  /** Directory for the log file(s). Defaults to `os.tmpdir()`. */
  dir?: string;
  formatter?: Formatter;
  /** Drop entries for which this returns `false`. */
  filter?: (entry: LogEntry) => boolean;
  /** Transport name for diagnostics and `removeTransport()`. Defaults to
   * `file:<appName>`. Unlike `appName`, it never appears in generated file
   * names — it only identifies this transport instance in memory. */
  name?: string;
  /** File extension without the dot. Defaults to `'log'`. */
  ext?: string;
  /**
   * Global cap on the **total** bytes of every file this transport owns in
   * `dir` (matched by the `${appName}.*.${ext}` shape). When exceeded, the
   * oldest files are deleted until back under the cap. Defaults to `Infinity`
   * (no limit). Works alongside, and independently of, `maxFiles` — whichever
   * limit is hit first trims from the oldest.
   */
  maxTotalSize?: number;
  /**
   * Global cap on file age. Any owned file (matched by `${appName}.*.${ext}`,
   * excluding the active file) whose modification time is older than
   * `maxAge` milliseconds is deleted.
   * - `undefined` or `-1` (default): no limit.
   * - `0`: delete all history files immediately.
   * - `>0`: threshold in milliseconds.
   */
  maxAge?: number;
}

/** 1.1 — write to one fixed file, appending forever until the disk is full. */
export interface SingleAppendOptions extends FileBaseOptions {
  mode: 'single';
}

/** 1.2 — single file; when it would exceed `maxSize`, copy it to a backup and
 * truncate the original so writing resumes from the top (a 2-file ring). */
export interface SingleTruncateOptions extends FileBaseOptions {
  mode: 'single-truncate';
  /** Size in bytes that triggers the backup+truncate cycle. */
  maxSize: number;
  /** Backup file name. Defaults to `${appName}.bak`. */
  backupName?: string;
}

/** 2.1 — roll by size, keeping up to `maxFiles` generations. */
export interface RotateSizeOptions extends FileBaseOptions {
  mode: 'rotate-size';
  /** Size in bytes that triggers a rotation. */
  maxSize: number;
  /** Number of generations to keep (active file + N-1 backups). `1` keeps only
   * the active file; `<=0` disables generation trimming. */
  maxFiles: number;
}

/** 2.2 — roll by time (hour or day), naming each file with a timestamp. */
export interface RotateTimeOptions extends FileBaseOptions {
  mode: 'rotate-time';
  /** Time granularity of a new file. */
  unit: 'hour' | 'day';
  /** Number of time buckets (stamps) to keep. When a bucket contains
   *  multiple seq files (via `maxSize`), the entire bucket is kept or
   *  deleted as a unit. `1` keeps only the newest bucket; `<=0` (or omitted)
   *  means unbounded. */
  maxFiles?: number;
  /**
   * Max bytes per time bucket. When the active file within the same time
   * bucket would exceed this limit, a new numbered part is created
   * (e.g. `app.2026-08-31-14.0.log`, `app.2026-08-31-14.1.log`).
   * Omit = no size cap (time-only rotation).
   */
  maxSize?: number;
  /** Max number of seq files kept **within a single time bucket**. When a
   * bucket would exceed this count, the oldest seq files inside that bucket
   * are deleted (the bucket forms an inner ring). Combined with `maxFiles`
   * and `maxSize`, this bounds total disk usage at roughly
   * `maxFiles × maxFilesPerBucket × maxSize` bytes. Omit = unbounded.
   */
  maxFilesPerBucket?: number;
  /** Override the clock (mainly for testing). Defaults to `new Date()`. */
  now?: () => Date;
}

/** Context handed to a custom rotation predicate. */
export interface RotateContext {
  entry: LogEntry;
  /** Bytes already written to the current active file. */
  size: number;
  /** ISO timestamp of the entry, for time-based decisions. */
  time: string;
}

/** 2.3 — fully custom rotation driven by a user predicate. */
export interface RotateCustomOptions extends FileBaseOptions {
  mode: 'rotate-custom';
  /** Return `true` to close the current file and open a new one. */
  shouldRotate: (entry: LogEntry, ctx: RotateContext) => boolean;
  /** Name the seq-th file. Required (no sensible default for custom). */
  fileName: (app: string, seq: number, ext: string) => string;
  /** Max number of files to keep. `1` keeps only the active file; `<=0` (or
   * omitted) means unbounded. */
  maxFiles?: number;
}

export type FileTransportOptions =
  | SingleAppendOptions
  | SingleTruncateOptions
  | RotateSizeOptions
  | RotateTimeOptions
  | RotateCustomOptions;

/** Metadata for a single log file managed by a {@link FileTransport}. */
export interface FileMeta {
  /** File name (e.g. `app.2026-09-01.0.log`). */
  name: string;
  /** Absolute path to the file. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** Last modification timestamp (milliseconds since epoch). */
  mtime: number;
  /** Whether this is the file currently being written to. */
  active: boolean;
}

/** Options for {@link FileTransport.getFiles}. */
export interface GetFilesOptions {
  /** When `true`, only return files created by the current transport instance
   *  (files that existed on disk before this instance started are excluded).
   *  Default `false`. */
  currentSessionOnly?: boolean;
}

function timeStamp(d: Date, unit: 'hour' | 'day'): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  if (unit === 'day') return `${y}-${m}-${day}`;
  const h = String(d.getHours()).padStart(2, '0');
  return `${y}-${m}-${day}-${h}`;
}

/**
 * A rotation strategy owns the per-mode state (active path, size bookkeeping,
 * sequence / time buckets) and decides, before each write, whether the current
 * file must be switched. `FileTransport` only handles the shared fs plumbing
 * (open/queue/mkdir/flush/close).
 */
interface Rotator {
  /** Path the next line will be written to. */
  activePath(): string;
  /** Before writing `bytes`, switch files if the strategy requires it.
   * Resolves to `true` when a rotation actually happened (a new file was
   * opened), so the transport can run its global capacity check. */
  prepare(bytes: number, entry: LogEntry, now: Date, fs: FileIo): Promise<boolean>;
  /** Reset transient state after the transport is closed (so a reopen re-stats). */
  reset(): void;
}

/** fs capabilities a rotator needs from the owning transport. */
interface FileIo {
  dir: string;
  ext: string;
  appName: string;
  /** Close the current file handle so a rotator can reopen a new path. */
  closeHandle(): Promise<void>;
  /** Current bytes already written to the active file. */
  getActiveSize(): Promise<number>;
  /** Files this transport has created — trimRing/trimTimeRing/caps only touch these. */
  owned: Set<string>;
}

// ---- shared helpers -------------------------------------------------------

/** Best-effort cap: delete the oldest bucket/generation files beyond `maxFiles`.
 * Only touches files the transport has explicitly created (tracked in `owned`).
 * When `exclude` is provided, files matching its basename are also kept (used
 * to protect the just-rotated-away file so it survives until the next bucket). */
async function trimRing(
  dir: string,
  appName: string,
  ext: string,
  maxFiles: number,
  owned: Set<string>,
  exclude?: string,
): Promise<void> {
  // maxFiles<1 → no cap configured; 1 means "keep active only, no backups".
  if (maxFiles < 1) return;
  const keep = maxFiles - 1;
  const excludeName = exclude ? basename(exclude) : undefined;
  try {
    const backups = (await readdir(dir))
      .filter(
        (f) =>
          owned.has(f) &&
          f !== `${appName}.${ext}` &&
          (excludeName === undefined || f !== excludeName),
      )
      .sort();
    const excess = backups.length - keep;
    for (let i = 0; i < excess; i++) {
      const toDelete = backups[i];
      await rm(join(dir, toDelete), { force: true }).catch(() => {});
      owned.delete(toDelete);
    }
  } catch {
    /* ignore */
  }
}

/** Best-effort cap that counts by **time buckets** (stamps) rather than files.
 * Groups owned files by their timestamp stamp, then deletes the oldest
 * complete bucket(s) when the number of distinct stamps exceeds `maxFiles`.
 * This is the correct trimming strategy for `rotate-time` with `maxSize`,
 * where a single bucket may produce multiple seq-numbered files. */
async function trimTimeRing(
  dir: string,
  appName: string,
  ext: string,
  maxFiles: number,
  owned: Set<string>,
): Promise<void> {
  if (maxFiles < 1) return;
  const prefix = `${appName}.`;
  const suffix = `.${ext}`;
  const stampRe = /^\d{4}-\d{2}-\d{2}(?:-\d{2})?/;
  try {
    // Group owned files by stamp.
    const groups = new Map<string, string[]>();
    for (const f of owned) {
      if (f === `${appName}.${ext}`) continue;
      if (!f.startsWith(prefix) || !f.endsWith(suffix)) continue;
      const body = f.slice(prefix.length, -suffix.length);
      const m = body.match(stampRe);
      if (m) {
        const stamp = m[0];
        let arr = groups.get(stamp);
        if (!arr) {
          arr = [];
          groups.set(stamp, arr);
        }
        arr.push(f);
      }
    }
    const stamps = [...groups.keys()].sort();
    const excess = stamps.length - maxFiles;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i++) {
      const files = groups.get(stamps[i])!;
      for (const f of files) {
        await rm(join(dir, f), { force: true }).catch(() => {});
        owned.delete(f);
      }
    }
  } catch {
    /* ignore */
  }
}

/** Best-effort cap on the number of seq files **within one time bucket**.
 * Deletes the oldest seq files of `stamp` when the bucket holds more than
 * `maxPerBucket` files, so a bucket forms an inner ring. The active file
 * (highest seq) is never deleted. Iterates the `owned` set (not the
 * directory) so the just-rotated-to active file — which may not exist on
 * disk yet — is still counted. Best-effort: any fs error is swallowed. */
async function trimBucketSeq(
  dir: string,
  appName: string,
  ext: string,
  stamp: string,
  maxPerBucket: number,
  owned: Set<string>,
): Promise<void> {
  if (maxPerBucket <= 0) return;
  const prefix = `${appName}.${stamp}.`;
  const suffix = `.${ext}`;
  try {
    const files = [...owned].filter((f) => f.startsWith(prefix) && f.endsWith(suffix)).sort();
    const excess = files.length - maxPerBucket;
    for (let i = 0; i < excess; i++) {
      await rm(join(dir, files[i]), { force: true }).catch(() => {});
      owned.delete(files[i]);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Global capacity guard: alongside (and independent of) per-mode `maxFiles`,
 * delete the **oldest** owned files when either a total-size cap or an age cap
 * is exceeded. "Oldest" is judged by modification time so it works uniformly
 * across every mode. The active file is never deleted, even if it is the
 * oldest. Best-effort: any fs error is swallowed.
 */
async function enforceGlobalCaps(params: {
  dir: string;
  activePath: string;
  maxTotalSize: number;
  maxAge: number; // -1 = no limit, 0 = delete all, >0 = threshold ms
  now: number;
  owned: Set<string>;
}): Promise<void> {
  const { dir, activePath, maxTotalSize, maxAge, now, owned } = params;
  if (!Number.isFinite(maxTotalSize) && maxAge < 0) return;
  try {
    const names = (await readdir(dir)).filter((f) => owned.has(f) && join(dir, f) !== activePath);
    const files = await Promise.all(
      names.map(async (f) => {
        try {
          const s = await stat(join(dir, f));
          return { name: f, size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          return null; // skip unstatable files — no infinite delete loop
        }
      }),
    );
    const valid = files.filter((f): f is NonNullable<typeof f> => f !== null);
    valid.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let activeSize = 0;
    try {
      activeSize = (await stat(activePath)).size;
    } catch {
      /* active file not created yet */
    }

    const toDelete: string[] = [];
    // Age cap: drop anything older than the threshold (0 = delete all).
    if (maxAge >= 0) {
      for (const f of valid) {
        if (maxAge === 0 || now - f.mtimeMs > maxAge) toDelete.push(f.name);
      }
    }
    // Size cap: drop oldest history files until active + history is under the limit.
    if (Number.isFinite(maxTotalSize)) {
      let total = activeSize;
      for (const f of valid) total += f.size;
      for (const f of valid) {
        if (total <= maxTotalSize) break;
        if (!toDelete.includes(f.name)) {
          toDelete.push(f.name);
          total -= f.size;
        }
      }
    }
    for (const f of toDelete) {
      await rm(join(dir, f), { force: true }).catch(() => {});
      owned.delete(f);
    }
  } catch {
    /* ignore */
  }
}

// ---- 1.1 single -----------------------------------------------------------

class SingleRotator implements Rotator {
  private readonly path: string;
  constructor(opts: SingleAppendOptions, dir: string, ext: string) {
    this.path = join(dir, `${opts.appName}.${ext}`);
  }
  activePath(): string {
    return this.path;
  }
  async prepare(_bytes: number, _entry: LogEntry, _now: Date, io: FileIo): Promise<boolean> {
    io.owned.add(basename(this.path));
    return false;
  }
  reset(): void {
    /* no transient state */
  }
}

// ---- 1.2 single-truncate --------------------------------------------------

class TruncateRotator implements Rotator {
  private readonly path: string;
  private readonly backup: string;
  private readonly maxSize: number;

  constructor(opts: SingleTruncateOptions, dir: string, ext: string) {
    this.path = join(dir, `${opts.appName}.${ext}`);
    this.backup = join(dir, opts.backupName ?? `${opts.appName}.bak`);
    this.maxSize = opts.maxSize;
  }
  activePath(): string {
    return this.path;
  }
  async prepare(bytes: number, _entry: LogEntry, _now: Date, io: FileIo): Promise<boolean> {
    io.owned.add(basename(this.path));
    io.owned.add(basename(this.backup));
    let size = 0;
    try {
      size = (await stat(this.path)).size;
    } catch {
      /* file not written yet */
    }
    if (size + bytes > this.maxSize) {
      await io.closeHandle();
      // Remove any previous backup first: on Windows `rename` refuses to
      // overwrite an existing target, which would otherwise block truncation.
      await rm(this.backup, { force: true }).catch(() => {});
      io.owned.delete(basename(this.backup));
      try {
        await rename(this.path, this.backup);
        io.owned.delete(basename(this.path));
        io.owned.add(basename(this.backup));
        return true; // truncated → a new active file was started
      } catch {
        /* nothing to back up yet */
      }
    }
    return false;
  }
  reset(): void {
    /* no transient state */
  }
}

// ---- 2.1 rotate-size -----------------------------------------------------

class SizeRotator implements Rotator {
  private readonly active: string;
  private readonly maxSize: number;
  private readonly maxFiles: number;

  constructor(opts: RotateSizeOptions, dir: string, ext: string) {
    this.active = join(dir, `${opts.appName}.${ext}`);
    this.maxSize = opts.maxSize;
    this.maxFiles = opts.maxFiles;
  }
  activePath(): string {
    return this.active;
  }
  private genPath(seq: number, io: FileIo): string {
    return join(io.dir, `${io.appName}.${seq}.${io.ext}`);
  }
  async prepare(bytes: number, _entry: LogEntry, _now: Date, io: FileIo): Promise<boolean> {
    io.owned.add(basename(this.active));
    let size = 0;
    try {
      size = (await stat(this.active)).size;
    } catch {
      /* file not written yet */
    }
    if (size + bytes > this.maxSize) {
      await io.closeHandle();
      if (this.maxFiles <= 1) {
        await rm(this.active, { force: true }).catch(() => {});
        return true;
      }
      const gens = this.maxFiles - 1;
      for (let k = gens; k >= 2; k--) {
        try {
          const from = this.genPath(k - 1, io);
          const to = this.genPath(k, io);
          await rename(from, to);
          io.owned.delete(basename(from));
          io.owned.add(basename(to));
        } catch {
          /* missing generation — skip */
        }
      }
      try {
        await rename(this.active, this.genPath(1, io));
        io.owned.delete(basename(this.active));
        io.owned.add(basename(this.genPath(1, io)));
      } catch {
        /* nothing to rotate yet */
      }
      // Generations are capped by the rename chain above; no extra trim needed.
      return true;
    }
    return false;
  }
  reset(): void {
    /* no transient state */
  }
}

// ---- 2.2 rotate-time -----------------------------------------------------

class TimeRotator implements Rotator {
  private readonly dir: string;
  private readonly ext: string;
  private readonly appName: string;
  private readonly unit: 'hour' | 'day';
  private readonly maxFiles?: number;
  private readonly maxSize?: number;
  private readonly maxFilesPerBucket?: number;
  private currentStamp: string | undefined;
  private seq = 0;
  private path: string;

  constructor(opts: RotateTimeOptions, dir: string, ext: string) {
    this.dir = dir;
    this.ext = ext;
    this.appName = opts.appName;
    this.unit = opts.unit;
    this.maxFiles = opts.maxFiles;
    this.maxSize = opts.maxSize;
    this.maxFilesPerBucket = opts.maxFilesPerBucket;
    this.path = join(dir, `${opts.appName}.${ext}`);
  }
  activePath(): string {
    return this.path;
  }
  private stampPath(stamp: string, seq: number): string {
    return join(this.dir, `${this.appName}.${stamp}.${seq}.${this.ext}`);
  }
  /** Most recent existing bucket at or before `upTo`, so a restart continues
   * the ring instead of orphaning yesterday's file. */
  private async latestExistingStamp(upTo: string): Promise<string | undefined> {
    try {
      const files = (await readdir(this.dir)).filter(
        (f) => f.startsWith(`${this.appName}.`) && f.endsWith(`.${this.ext}`),
      );
      const stampRe = this.unit === 'hour' ? /^\d{4}-\d{2}-\d{2}-\d{2}/ : /^\d{4}-\d{2}-\d{2}/;
      const prefix = `${this.appName}.`;
      const suffix = `.${this.ext}`;
      files.sort();
      for (let i = files.length - 1; i >= 0; i--) {
        const body = files[i].slice(prefix.length, -suffix.length);
        // body is either `${stamp}` or `${stamp}.${seq}` — extract stamp
        const dotIdx = body.lastIndexOf('.');
        const stamp = dotIdx > 0 ? body.slice(0, dotIdx) : body;
        if (stampRe.test(stamp) && stamp <= upTo) return stamp;
      }
    } catch {
      /* directory not readable yet — start fresh */
    }
    return undefined;
  }
  /** Find the highest seq number among files in the given time bucket. */
  private async latestExistingSeq(stamp: string): Promise<number> {
    if (!this.maxSize) return 0;
    try {
      const prefix = `${this.appName}.${stamp}.`;
      const suffix = `.${this.ext}`;
      const files = (await readdir(this.dir)).filter(
        (f) => f.startsWith(prefix) && f.endsWith(suffix),
      );
      let maxSeq = 0;
      for (const f of files) {
        const body = f.slice(this.appName.length + 1, -this.ext.length - 1);
        // body is `${stamp}.${seq}`
        const parts = body.split('.');
        const seq = Number(parts[parts.length - 1]);
        if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
      }
      return maxSeq;
    } catch {
      return 0;
    }
  }
  async prepare(bytes: number, _entry: LogEntry, now: Date, io: FileIo): Promise<boolean> {
    const stamp = timeStamp(now, this.unit);
    if (this.currentStamp === undefined) {
      const existing = await this.latestExistingStamp(stamp);
      this.currentStamp = existing ?? stamp;
      this.seq = await this.latestExistingSeq(this.currentStamp);
      this.path = this.stampPath(this.currentStamp, this.seq);
      io.owned.add(basename(this.path));
      if (existing && existing !== stamp) {
        // Bucket already rolled over; open the new one and drop stale files.
        this.currentStamp = stamp;
        this.seq = 0;
        await io.closeHandle();
        this.path = this.stampPath(stamp, 0);
        io.owned.add(basename(this.path));
        await trimTimeRing(io.dir, io.appName, io.ext, this.maxFiles ?? 0, io.owned);
        return true;
      }
      await trimTimeRing(io.dir, io.appName, io.ext, this.maxFiles ?? 0, io.owned);
      return false;
    }
    if (stamp !== this.currentStamp) {
      // Time bucket changed — archive the previous file and open a new one.
      this.currentStamp = stamp;
      this.seq = 0;
      await io.closeHandle();
      this.path = this.stampPath(stamp, 0);
      io.owned.add(basename(this.path));
      await trimTimeRing(io.dir, io.appName, io.ext, this.maxFiles ?? 0, io.owned);
      return true;
    }
    // Same time bucket — check size-based splitting within the bucket.
    if (this.maxSize !== undefined) {
      let size = 0;
      try {
        size = (await stat(this.path)).size;
      } catch {
        /* file not written yet */
      }
      if (size + bytes > this.maxSize) {
        this.seq += 1;
        await io.closeHandle();
        this.path = this.stampPath(this.currentStamp, this.seq);
        io.owned.add(basename(this.path));
        await trimTimeRing(io.dir, io.appName, io.ext, this.maxFiles ?? 0, io.owned);
        // Cap the seq count inside the current bucket (inner ring).
        await trimBucketSeq(
          io.dir,
          io.appName,
          io.ext,
          this.currentStamp,
          this.maxFilesPerBucket ?? 0,
          io.owned,
        );
        return true;
      }
    }
    return false;
  }
  reset(): void {
    this.currentStamp = undefined;
    this.seq = 0;
    this.path = join(this.dir, `${this.appName}.${this.ext}`);
  }
}

// ---- 2.3 rotate-custom ---------------------------------------------------

class CustomRotator implements Rotator {
  private readonly dir: string;
  private readonly ext: string;
  private readonly appName: string;
  private readonly maxFiles?: number;
  private readonly shouldRotate: (entry: LogEntry, ctx: RotateContext) => boolean;
  private readonly fileName: (app: string, seq: number, ext: string) => string;
  private seq = 0;
  private path: string;

  constructor(opts: RotateCustomOptions, dir: string, ext: string) {
    this.dir = dir;
    this.ext = ext;
    this.appName = opts.appName;
    this.maxFiles = opts.maxFiles;
    this.shouldRotate = opts.shouldRotate;
    this.fileName = opts.fileName;
    this.path = join(dir, this.fileName(opts.appName, 0, ext));
  }
  activePath(): string {
    return this.path;
  }
  async prepare(_bytes: number, entry: LogEntry, now: Date, io: FileIo): Promise<boolean> {
    const size = await io.getActiveSize();
    const ctx: RotateContext = {
      entry,
      size,
      time: now.toISOString(),
    };
    if (this.shouldRotate(entry, ctx)) {
      this.seq += 1;
      await io.closeHandle();
      this.path = join(io.dir, this.fileName(io.appName, this.seq, io.ext));
      io.owned.add(basename(this.path));
      await trimRing(io.dir, io.appName, io.ext, this.maxFiles ?? 0, io.owned);
      return true;
    }
    return false;
  }
  reset(): void {
    this.seq = 0;
    this.path = join(this.dir, this.fileName(this.appName, 0, this.ext));
  }
}

/**
 * Single file transport covering every file-output strategy. Each strategy is
 * an isolated `Rotator` (see above); this class only performs the shared
 * filesystem plumbing on a serialized queue.
 *
 * Modes:
 *  - `single` (1.1): one fixed file, append forever.
 *  - `single-truncate` (1.2): back up + truncate when `maxSize` would be exceeded.
 *  - `rotate-size` (2.1): roll by size into N generations.
 *  - `rotate-time` (2.2): roll by hour/day into timestamped files.
 *  - `rotate-custom` (2.3): roll whenever a user predicate says so.
 *
 * `appName` is required and is embedded in every file name.
 */
export class FileTransport implements Transport {
  readonly name: string;
  readonly formatter: Formatter;
  readonly filter?: (entry: LogEntry) => boolean;
  /** Optional error hook, forwarded to the pipeline's global `onLoggerError`. */
  onError?(err: unknown, entry: LogEntry): void;

  /** Effective capacity limits, for diagnostics (e.g. "why was my log file
   * deleted?"). `maxSize`/`maxFiles` reflect the active rotation mode;
   * `maxTotalSize`/`maxAge` are the global caps (`Infinity`/`-1` = unset). */
  get caps(): {
    maxSize?: number;
    maxFiles?: number;
    maxFilesPerBucket?: number;
    maxTotalSize: number;
    maxAge: number;
  } {
    const o = this.options;
    return {
      maxSize: 'maxSize' in o ? o.maxSize : undefined,
      maxFiles: 'maxFiles' in o ? o.maxFiles : undefined,
      maxFilesPerBucket: 'maxFilesPerBucket' in o ? o.maxFilesPerBucket : undefined,
      maxTotalSize: this.maxTotalSize,
      maxAge: this.maxAge,
    };
  }

  private readonly options: FileTransportOptions;
  private readonly dir: string;
  private readonly ext: string;
  private readonly io: FileIo;
  private readonly rotator: Rotator;
  private readonly clock: () => Date;
  private readonly maxTotalSize: number; // Infinity = no limit
  private readonly maxAge: number; // ms; -1 = no limit, 0 = delete all, >0 = threshold
  private readonly owned = new Set<string>();
  private readonly createdAt: number;
  private closed = false;
  private handle: Awaited<ReturnType<typeof open>> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private ownedScanned = false;
  // Throttled periodic capacity check (in addition to the mandatory check that
  // runs after every rotation): inspect at most once per `PERIODIC_EVERY`
  // writes and at most once per `PERIODIC_INTERVAL_MS`.
  private static readonly PERIODIC_EVERY = 256;
  private static readonly PERIODIC_INTERVAL_MS = 60_000;
  private writeCount = 0;
  private lastCheckMs = 0;
  // Captured so the error handler can report the failed entry even though the
  // queue serialises writes. Only the *last* entry is kept — errors are rare.
  private _lastWrittenEntry: LogEntry | null = null;

  constructor(options: FileTransportOptions) {
    if (!options.appName) {
      throw new Error('FileTransport requires an "appName"');
    }
    this.options = options;
    this.dir = options.dir ?? tmpdir();
    this.ext = options.ext ?? 'log';
    this.name = options.name ?? `file:${options.appName}`;
    this.formatter = options.formatter ?? createJsonFormatter();
    this.filter = options.filter;
    this.maxTotalSize = options.maxTotalSize ?? Infinity;
    this.maxAge = options.maxAge ?? -1;
    this.createdAt = Date.now();

    switch (options.mode) {
      case 'single':
        this.rotator = new SingleRotator(options, this.dir, this.ext);
        break;
      case 'single-truncate':
        this.rotator = new TruncateRotator(options, this.dir, this.ext);
        break;
      case 'rotate-size':
        this.rotator = new SizeRotator(options, this.dir, this.ext);
        break;
      case 'rotate-time':
        this.rotator = new TimeRotator(options, this.dir, this.ext);
        break;
      case 'rotate-custom':
        this.rotator = new CustomRotator(options, this.dir, this.ext);
        break;
    }

    // Capture the clock synchronously at write time so a rotate-time transport
    // uses the timestamp of the call, not a later microtask.
    this.clock = options.mode === 'rotate-time' && options.now ? options.now : () => new Date();

    this.io = {
      dir: this.dir,
      ext: this.ext,
      appName: options.appName,
      closeHandle: () => this.closeHandle(),
      getActiveSize: () => this.getActiveSize(),
      owned: this.owned,
    };
  }

  /** Absolute path of the log directory. */
  getDir(): string {
    return this.dir;
  }

  /** Absolute path of the file currently being written to. */
  getActiveFile(): string {
    return this.rotator.activePath();
  }

  /** List all log files managed by this transport.
   *
   *  By default returns every file the transport knows about, including
   *  files left over from previous runs (discovered via `scanOwned`). Pass
   *  `{ currentSessionOnly: true }` to restrict the result to files created
   *  by the current transport instance. */
  async getFiles(options?: GetFilesOptions): Promise<FileMeta[]> {
    await this.scanOwned();
    const activePath = this.rotator.activePath();
    const results: FileMeta[] = [];
    for (const name of this.owned) {
      const filePath = join(this.dir, name);
      try {
        const s = await stat(filePath);
        if (options?.currentSessionOnly && s.mtimeMs < this.createdAt) continue;
        results.push({
          name,
          path: filePath,
          size: s.size,
          mtime: s.mtimeMs,
          active: filePath === activePath,
        });
      } catch {
        // file disappeared between readdir and stat — skip
      }
    }
    return results;
  }

  private async ensureHandle(): Promise<Awaited<ReturnType<typeof open>>> {
    if (!this.handle) {
      await this.scanOwned();
      await mkdir(dirname(this.rotator.activePath()), { recursive: true });
      this.handle = await open(this.rotator.activePath(), 'a');
      this.io.owned.add(basename(this.rotator.activePath()));
    }
    return this.handle;
  }

  private async scanOwned(): Promise<void> {
    if (this.ownedScanned) return;
    this.ownedScanned = true;
    try {
      const files = await readdir(this.dir);
      const prefix = `${this.io.appName}.`;
      const suffix = `.${this.io.ext}`;
      for (const f of files) {
        if (f.startsWith(prefix) && f.endsWith(suffix)) {
          this.io.owned.add(f);
        }
      }
    } catch {
      /* ignore scan failures */
    }
  }

  private async closeHandle(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }

  private async getActiveSize(): Promise<number> {
    try {
      return (await stat(this.rotator.activePath())).size;
    } catch {
      return 0;
    }
  }

  write(entry: LogEntry, formatted: string): void | Promise<void> {
    if (this.closed || (this.filter && !this.filter(entry))) return;
    const line = formatted + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    const now = this.clock();
    const nowMs = now.getTime();
    const task = this.queue
      .then(async () => {
        const rotated = await this.rotator.prepare(bytes, entry, now, this.io);
        // Run the global cap check only when a rotation just happened (a new
        // file landed) — that is when stale files can exceed the caps. Non-
        // rotating modes (e.g. `single`) rely on the throttled periodic check
        // below, so we never scan the directory on every hot-path write.
        if (rotated) {
          await enforceGlobalCaps({
            dir: this.dir,
            activePath: this.rotator.activePath(),
            maxTotalSize: this.maxTotalSize,
            maxAge: this.maxAge,
            now: nowMs,
            owned: this.io.owned,
          });
        }
        // Throttled periodic check so caps are still honored between rotations
        // (or when a mode never rotates). At most once per PERIODIC_EVERY writes
        // and once per PERIODIC_INTERVAL_MS.
        this.writeCount++;
        const due =
          this.writeCount % FileTransport.PERIODIC_EVERY === 0 &&
          nowMs - this.lastCheckMs >= FileTransport.PERIODIC_INTERVAL_MS;
        if (due) {
          this.lastCheckMs = nowMs;
          await enforceGlobalCaps({
            dir: this.dir,
            activePath: this.rotator.activePath(),
            maxTotalSize: this.maxTotalSize,
            maxAge: this.maxAge,
            now: nowMs,
            owned: this.io.owned,
          });
        }
        const handle = await this.ensureHandle();
        this._lastWrittenEntry = entry;
        await handle.write(line);
      })
      .catch((err) => {
        // Report every write error so the user can detect disk-full, EPERM, etc.
        if (this.onError) {
          this.onError(
            new Error(
              `FileTransport write error: ${err instanceof Error ? err.message : String(err)}`,
            ),
            this._lastWrittenEntry!,
          );
        } else {
          console.error('[lograil] FileTransport write error:', err);
        }
      });
    this.queue = task;
    return task;
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    await this.queue;
    await this.closeHandle();
    this.rotator.reset();
    this.closed = true;
  }
}
