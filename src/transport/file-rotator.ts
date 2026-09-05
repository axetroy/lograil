import { rename, rm, stat, readdir } from '../shims/index.js';
import { basename, join } from '../shims/index.js';
import type { LogEntry } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';

// ---- error callback type --------------------------------------------------

/**
 * Callback for non-fatal filesystem errors inside the file transport.
 *
 * The `level` indicates severity:
 * - `'warn'` — a best-effort operation (readdir, delete) failed unexpectedly;
 *   the transport keeps running but the problem should be investigated.
 * - `'debug'` — a routine best-effort cleanup (e.g. `rm` of a backup) failed;
 *   normally harmless but useful for deep debugging.
 *
 * The transport **never throws** from filesystem helpers; every error is
 * forwarded here (if provided) so callers can log, metric, or ignore it.
 */
export type FileErrorCallback = (level: 'warn' | 'debug', message: string, cause?: unknown) => void;

/** Fields every file mode shares. `appName` is required so the log file name
 * always embeds the application identity. */
export interface FileBaseOptions {
  /** Application name; embedded in every generated log file name. */
  appName: string;
  /** Directory for the log file(s). Defaults to `os.tmpdir()`. */
  dir?: string;
  /** Formatter used to convert a {@link LogEntry} into the string written to disk. */
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

/** All supported file-transport option shapes. The `mode` discriminant selects
 * the rotation strategy used at runtime. */
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

/** Format a `Date` as a bucket stamp (`YYYY-MM-DD` for day, `YYYY-MM-DD-HH`
 * for hour). Used as the file-name infix for `rotate-time` mode. */
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
export interface Rotator {
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
export interface FileIo {
  /** Directory the active log file lives in. */
  dir: string;
  /** File extension without the dot (e.g. `'log'`). */
  ext: string;
  /** Application name used as the prefix of every generated file name. */
  appName: string;
  /** Close the current file handle so a rotator can reopen a new path. */
  closeHandle(): Promise<void>;
  /** Current bytes already written to the active file. */
  getActiveSize(): Promise<number>;
  /** Files this transport has created — trimRing/trimTimeRing/caps only touch these. */
  owned: Set<string>;
  /**
   * Optional callback for non-fatal filesystem errors during trim/cap
   * operations. When absent, errors are silently swallowed (legacy behaviour).
   */
  onError?: FileErrorCallback;
}

// ---- shared helpers -------------------------------------------------------

/** Best-effort cap: delete the oldest bucket/generation files beyond `maxFiles`.
 * Only touches files the transport has explicitly created (tracked in `owned`).
 * When `exclude` is provided, files matching its basename are also kept (used
 * to protect the just-rotated-away file so it survives until the next bucket). */
export async function trimRing(
  dir: string,
  appName: string,
  ext: string,
  maxFiles: number,
  owned: Set<string>,
  exclude?: string,
  onError?: FileErrorCallback,
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
      await rm(join(dir, toDelete), { force: true }).catch((err) => {
        onError?.('debug', `trimRing: failed to delete ${toDelete}`, err);
      });
      owned.delete(toDelete);
    }
  } catch (err) {
    onError?.('warn', `trimRing: readdir or filter failed in ${dir}`, err);
  }
}

/** Best-effort cap that counts by **time buckets** (stamps) rather than files.
 * Groups owned files by their timestamp stamp, then deletes the oldest
 * complete bucket(s) when the number of distinct stamps exceeds `maxFiles`.
 * This is the correct trimming strategy for `rotate-time` with `maxSize`,
 * where a single bucket may produce multiple seq-numbered files. */
export async function trimTimeRing(
  dir: string,
  appName: string,
  ext: string,
  maxFiles: number,
  owned: Set<string>,
  onError?: FileErrorCallback,
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
        await rm(join(dir, f), { force: true }).catch((err) => {
          onError?.('debug', `trimTimeRing: failed to delete ${f}`, err);
        });
        owned.delete(f);
      }
    }
  } catch (err) {
    onError?.('warn', `trimTimeRing: readdir or grouping failed in ${dir}`, err);
  }
}

/** Best-effort cap on the number of seq files **within one time bucket**.
 * Deletes the oldest seq files of `stamp` when the bucket holds more than
 * `maxPerBucket` files, so a bucket forms an inner ring. The active file
 * (highest seq) is never deleted. Iterates the `owned` set (not the
 * directory) so the just-rotated-to active file — which may not exist on
 * disk yet — is still counted. Best-effort: any fs error is swallowed. */
export async function trimBucketSeq(
  dir: string,
  appName: string,
  ext: string,
  stamp: string,
  maxPerBucket: number,
  owned: Set<string>,
  onError?: FileErrorCallback,
): Promise<void> {
  if (maxPerBucket <= 0) return;
  const prefix = `${appName}.${stamp}.`;
  const suffix = `.${ext}`;
  try {
    const files = [...owned].filter((f) => f.startsWith(prefix) && f.endsWith(suffix)).sort();
    const excess = files.length - maxPerBucket;
    for (let i = 0; i < excess; i++) {
      await rm(join(dir, files[i]), { force: true }).catch((err) => {
        onError?.('debug', `trimBucketSeq: failed to delete ${files[i]}`, err);
      });
      owned.delete(files[i]);
    }
  } catch (err) {
    onError?.('warn', `trimBucketSeq: filter or delete failed in ${dir}`, err);
  }
}

/**
 * Global capacity guard: alongside (and independent of) per-mode `maxFiles`,
 * delete the **oldest** owned files when either a total-size cap or an age cap
 * is exceeded. "Oldest" is judged by modification time so it works uniformly
 * across every mode. The active file is never deleted, even if it is the
 * oldest. Best-effort: any fs error is swallowed.
 */
export async function enforceGlobalCaps(params: {
  dir: string;
  activePath: string;
  maxTotalSize: number;
  maxAge: number; // -1 = no limit, 0 = delete all, >0 = threshold ms
  now: number;
  owned: Set<string>;
  onError?: FileErrorCallback;
}): Promise<void> {
  const { dir, activePath, maxTotalSize, maxAge, now, owned, onError } = params;
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
      await rm(join(dir, f), { force: true }).catch((err) => {
        onError?.('debug', `enforceGlobalCaps: failed to delete ${f}`, err);
      });
      owned.delete(f);
    }
  } catch (err) {
    onError?.('warn', `enforceGlobalCaps: readdir or stat failed in ${dir}`, err);
  }
}

// ---- 1.1 single -----------------------------------------------------------

/** Append-only strategy: writes to a single fixed file forever. */
export class SingleRotator implements Rotator {
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

/** Single-file strategy with backup truncation: when the active file would
 * exceed `maxSize`, it is copied to a backup and the active file is
 * reset to zero length. */
export class TruncateRotator implements Rotator {
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
      await rm(this.backup, { force: true }).catch((err) => {
        io.onError?.('debug', `TruncateRotator: failed to remove backup ${this.backup}`, err);
      });
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

/** Size-based rotation: when the active file exceeds `maxSize`, existing
 * generations are shifted up by one and the active file is reset.
 * At most `maxFiles` generations are kept. */
export class SizeRotator implements Rotator {
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
        await rm(this.active, { force: true }).catch((err) => {
          io.onError?.('debug', `SizeRotator: failed to remove active file ${this.active}`, err);
        });
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

/** Time-based rotation: a new file is created at each time boundary
 * (hour or day). Optionally combined with `maxSize` to split a single
 * bucket into multiple seq files. Old buckets beyond `maxFiles` are
 * deleted as a unit. */
export class TimeRotator implements Rotator {
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
        await trimTimeRing(io.dir, io.appName, io.ext, this.maxFiles ?? 0, io.owned, io.onError);
        return true;
      }
      await trimTimeRing(io.dir, io.appName, io.ext, this.maxFiles ?? 0, io.owned, io.onError);
      return false;
    }
    if (stamp !== this.currentStamp) {
      // Time bucket changed — archive the previous file and open a new one.
      this.currentStamp = stamp;
      this.seq = 0;
      await io.closeHandle();
      this.path = this.stampPath(stamp, 0);
      io.owned.add(basename(this.path));
      await trimTimeRing(io.dir, io.appName, io.ext, this.maxFiles ?? 0, io.owned, io.onError);
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
        await trimTimeRing(io.dir, io.appName, io.ext, this.maxFiles ?? 0, io.owned, io.onError);
        // Cap the seq count inside the current bucket (inner ring).
        await trimBucketSeq(
          io.dir,
          io.appName,
          io.ext,
          this.currentStamp,
          this.maxFilesPerBucket ?? 0,
          io.owned,
          io.onError,
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

/** Fully custom rotation driven by a user-supplied predicate. The user
 * provides `shouldRotate` (decides when to roll) and `fileName` (generates
 * the path for each sequence number). */
export class CustomRotator implements Rotator {
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
      await trimRing(
        io.dir,
        io.appName,
        io.ext,
        this.maxFiles ?? 0,
        io.owned,
        undefined,
        io.onError,
      );
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

/** Create the appropriate {@link Rotator} for the given options.
 * Exhaustively switches on `options.mode` — the type system guarantees
 * that every mode is handled. */
export function createRotator(options: FileTransportOptions, dir: string, ext: string): Rotator {
  switch (options.mode) {
    case 'single':
      return new SingleRotator(options, dir, ext);
    case 'single-truncate':
      return new TruncateRotator(options, dir, ext);
    case 'rotate-size':
      return new SizeRotator(options, dir, ext);
    case 'rotate-time':
      return new TimeRotator(options, dir, ext);
    case 'rotate-custom':
      return new CustomRotator(options, dir, ext);
    default: {
      const _exhaustive: never = options as never;
      throw new Error(`Unsupported file mode: ${String(_exhaustive)}`);
    }
  }
}
