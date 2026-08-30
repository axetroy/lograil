import { mkdir, open, rename, rm, stat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
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
  name?: string;
  /** File extension without the dot. Defaults to `'log'`. */
  ext?: string;
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
  /** Number of generations to keep (active file + N-1 backups). */
  maxFiles: number;
  /** Name the i-th generation file. Defaults to `${app}.${i}.${ext}`. */
  fileName?: (app: string, index: number, ext: string) => string;
}

/** 2.2 — roll by time (hour or day), naming each file with a timestamp. */
export interface RotateTimeOptions extends FileBaseOptions {
  mode: 'rotate-time';
  /** Time granularity of a new file. */
  unit: 'hour' | 'day';
  /** Number of time-bucketed files to keep (ring buffer). Omit = unbounded. */
  maxFiles?: number;
  /** Name a file for a time bucket. Defaults to `${app}.${stamp}.${ext}`. */
  fileName?: (app: string, stamp: string, ext: string) => string;
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
  /** Max number of files to keep. Omit = unbounded. */
  maxFiles?: number;
}

export type FileTransportOptions =
  | SingleAppendOptions
  | SingleTruncateOptions
  | RotateSizeOptions
  | RotateTimeOptions
  | RotateCustomOptions;

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
  /** Before writing `bytes`, switch files if the strategy requires it. */
  prepare(bytes: number, entry: LogEntry, now: Date, fs: FileIo): Promise<void>;
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
}

// ---- shared helpers -------------------------------------------------------

/** Best-effort cap: delete the oldest bucket/generation files beyond `maxFiles`.
 * Lenient by design — custom `fileName()` shapes are user-defined, so we only
 * match the conventional `${app}.<suffix>.${ext}` names. */
async function trimRing(
  dir: string,
  appName: string,
  ext: string,
  maxFiles: number,
): Promise<void> {
  if (maxFiles <= 1) return;
  try {
    const entries = (await readdir(dir)).filter((f) => f.startsWith(`${appName}.`));
    const backups = entries.filter((f) => f !== `${appName}.${ext}`).sort();
    const excess = backups.length - (maxFiles - 1);
    for (let i = 0; i < excess; i++) {
      await rm(join(dir, backups[i]), { force: true }).catch(() => {});
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
  async prepare(): Promise<void> {
    /* never switches */
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
  async prepare(bytes: number, _entry: LogEntry, _now: Date, io: FileIo): Promise<void> {
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
      try {
        await rename(this.path, this.backup);
      } catch {
        /* nothing to back up yet */
      }
    }
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
  private readonly fileName: (app: string, index: number, ext: string) => string;

  constructor(opts: RotateSizeOptions, dir: string, ext: string) {
    this.active = join(dir, `${opts.appName}.${ext}`);
    this.maxSize = opts.maxSize;
    this.maxFiles = opts.maxFiles;
    this.fileName = opts.fileName ?? ((app, i, e) => `${app}.${i}.${e}`);
  }
  activePath(): string {
    return this.active;
  }
  private genPath(index: number, io: FileIo): string {
    return join(io.dir, this.fileName(io.appName, index, io.ext));
  }
  async prepare(bytes: number, _entry: LogEntry, _now: Date, io: FileIo): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.active)).size;
    } catch {
      /* file not written yet */
    }
    if (size + bytes > this.maxSize) {
      await io.closeHandle();
      const gens = this.maxFiles - 1;
      for (let k = gens; k >= 2; k--) {
        try {
          await rename(this.genPath(k - 1, io), this.genPath(k, io));
        } catch {
          /* missing generation — skip */
        }
      }
      try {
        await rename(this.active, this.genPath(1, io));
      } catch {
        /* nothing to rotate yet */
      }
      // Generations are capped by the rename chain above; no extra trim needed.
    }
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
  private readonly fileName: (app: string, stamp: string, ext: string) => string;
  private currentStamp: string | undefined;
  private path: string;

  constructor(opts: RotateTimeOptions, dir: string, ext: string) {
    this.dir = dir;
    this.ext = ext;
    this.appName = opts.appName;
    this.unit = opts.unit;
    this.maxFiles = opts.maxFiles;
    this.fileName = opts.fileName ?? ((app, s, e) => `${app}.${s}.${e}`);
    this.path = join(dir, `${opts.appName}.${ext}`);
  }
  activePath(): string {
    return this.path;
  }
  private stampPath(stamp: string): string {
    return join(this.dir, this.fileName(this.appName, stamp, this.ext));
  }
  /** Most recent existing bucket at or before `upTo`, so a restart continues
   * the ring instead of orphaning yesterday's file. */
  private async latestExistingStamp(upTo: string): Promise<string | undefined> {
    try {
      const files = (await readdir(this.dir)).filter(
        (f) => f.startsWith(`${this.appName}.`) && f.endsWith(`.${this.ext}`),
      );
      const stampRe = this.unit === 'hour' ? /^\d{4}-\d{2}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
      const prefix = `${this.appName}.`;
      const suffix = `.${this.ext}`;
      files.sort();
      for (let i = files.length - 1; i >= 0; i--) {
        const stamp = files[i].slice(prefix.length, -suffix.length);
        if (stampRe.test(stamp) && stamp <= upTo) return stamp;
      }
    } catch {
      /* directory not readable yet — start fresh */
    }
    return undefined;
  }
  async prepare(_bytes: number, _entry: LogEntry, now: Date, io: FileIo): Promise<void> {
    const stamp = timeStamp(now, this.unit);
    if (this.currentStamp === undefined) {
      const existing = await this.latestExistingStamp(stamp);
      this.currentStamp = existing ?? stamp;
      this.path = this.stampPath(this.currentStamp);
      if (existing && existing !== stamp) {
        // Bucket already rolled over; open the new one and drop stale files.
        this.currentStamp = stamp;
        await io.closeHandle();
        this.path = this.stampPath(stamp);
      }
      await trimRing(io.dir, io.appName, io.ext, this.maxFiles ?? 0);
      return;
    }
    if (stamp !== this.currentStamp) {
      this.currentStamp = stamp;
      await io.closeHandle();
      this.path = this.stampPath(stamp);
      await trimRing(io.dir, io.appName, io.ext, this.maxFiles ?? 0);
    }
  }
  reset(): void {
    this.currentStamp = undefined;
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
  async prepare(_bytes: number, entry: LogEntry, now: Date, io: FileIo): Promise<void> {
    const ctx: RotateContext = {
      entry,
      size: 0,
      time: now.toISOString(),
    };
    if (this.shouldRotate(entry, ctx)) {
      this.seq += 1;
      await io.closeHandle();
      this.path = join(io.dir, this.fileName(io.appName, this.seq, io.ext));
      await trimRing(io.dir, io.appName, io.ext, this.maxFiles ?? 0);
    }
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

  private readonly dir: string;
  private readonly ext: string;
  private readonly io: FileIo;
  private readonly rotator: Rotator;
  private readonly clock: () => Date;
  private handle: Awaited<ReturnType<typeof open>> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: FileTransportOptions) {
    if (!options.appName) {
      throw new Error('FileTransport requires an "appName"');
    }
    this.dir = options.dir ?? tmpdir();
    this.ext = options.ext ?? 'log';
    this.name = options.name ?? `file:${options.appName}`;
    this.formatter = options.formatter ?? createJsonFormatter();
    this.filter = options.filter;

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
    };
  }

  private async ensureHandle(): Promise<Awaited<ReturnType<typeof open>>> {
    if (!this.handle) {
      await mkdir(dirname(this.rotator.activePath()), { recursive: true });
      this.handle = await open(this.rotator.activePath(), 'a');
    }
    return this.handle;
  }

  private async closeHandle(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }

  write(entry: LogEntry, formatted: string): void | Promise<void> {
    if (this.filter && !this.filter(entry)) return; // dropped by filter
    const line = formatted + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    const now = this.clock();
    const task = this.queue
      .then(async () => {
        await this.rotator.prepare(bytes, entry, now, this.io);
        const handle = await this.ensureHandle();
        await handle.write(line);
      })
      .catch(() => {
        /* swallow write errors to avoid crashing the app */
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
  }
}
