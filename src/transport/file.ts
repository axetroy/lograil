import { mkdir, open, rename, stat } from 'node:fs/promises';
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
 * Single file transport covering every file-output strategy:
 *
 * - `single` (1.1): one fixed file, append forever.
 * - `single-truncate` (1.2): one file; on overflow copy to a backup and
 *   truncate the original (a 2-file ring).
 * - `rotate-size` (2.1): roll by size into N generations.
 * - `rotate-time` (2.2): roll by hour/day into timestamped files.
 * - `rotate-custom` (2.3): roll whenever a user predicate says so.
 *
 * `appName` is required and is embedded in every file name.
 */
export class FileTransport implements Transport {
  readonly name: string;
  readonly formatter: Formatter;
  readonly filter?: (entry: LogEntry) => boolean;

  private readonly opts: FileTransportOptions;
  private readonly dir: string;
  private readonly ext: string;
  private readonly now: () => Date;
  private handle: Awaited<ReturnType<typeof open>> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private size = 0;
  private sizeInitialized = false;
  /** Active file path (for single / single-truncate / rotate-size index 0). */
  private activePath: string;
  /** rotate-time/rotate-custom: current bucket stamp / sequence. */
  private currentStamp: string | undefined;
  private seq = 0;

  constructor(options: FileTransportOptions) {
    this.opts = options;
    if (!options.appName) {
      throw new Error('FileTransport requires an "appName"');
    }
    this.dir = options.dir ?? tmpdir();
    this.ext = options.ext ?? 'log';
    this.now =
      'now' in options && typeof (options as { now?: () => Date }).now === 'function'
        ? (options as { now: () => Date }).now
        : () => new Date();
    this.name = options.name ?? `file:${options.appName}`;
    this.formatter = options.formatter ?? createJsonFormatter();
    this.filter = options.filter;
    this.activePath = options.mode === 'rotate-custom' ? this.customPath(0) : this.basePath();
  }

  // ---- path helpers -------------------------------------------------------

  private basePath(): string {
    const o = this.opts;
    return join(this.dir, `${o.appName}.${this.ext}`);
  }

  private genPath(index: number): string {
    const o = this.opts as RotateSizeOptions;
    const fn = o.fileName ?? ((app, i, ext) => `${app}.${i}.${ext}`);
    return join(this.dir, fn(o.appName, index, this.ext));
  }

  private stampPath(stamp: string): string {
    const o = this.opts as RotateTimeOptions;
    const fn = o.fileName ?? ((app, s, ext) => `${app}.${s}.${ext}`);
    return join(this.dir, fn(o.appName, stamp, this.ext));
  }

  private customPath(seq: number): string {
    const o = this.opts as RotateCustomOptions;
    return join(this.dir, o.fileName(o.appName, seq, this.ext));
  }

  // ---- shared fs plumbing --------------------------------------------------

  private async ensureHandle(): Promise<Awaited<ReturnType<typeof open>>> {
    if (!this.handle) {
      await mkdir(dirname(this.activePath), { recursive: true });
      this.handle = await open(this.activePath, 'a');
    }
    return this.handle;
  }

  private async ensureSize(): Promise<void> {
    if (this.sizeInitialized) return;
    try {
      const st = await stat(this.activePath);
      this.size = st.size;
    } catch {
      this.size = 0;
    }
    this.sizeInitialized = true;
  }

  // ---- per-mode "should we switch before writing?" ------------------------

  private async prepare(bytes: number, entry: LogEntry, now: Date): Promise<void> {
    const o = this.opts;
    switch (o.mode) {
      case 'single':
        return; // never switch

      case 'single-truncate': {
        await this.ensureSize();
        if (this.size + bytes > o.maxSize) {
          if (this.handle) {
            await this.handle.close();
            this.handle = null;
          }
          const backup = join(this.dir, o.backupName ?? `${o.appName}.bak`);
          try {
            await rename(this.activePath, backup);
          } catch {
            /* nothing to back up yet */
          }
          this.size = 0;
          this.sizeInitialized = true;
        }
        return;
      }

      case 'rotate-size': {
        await this.ensureSize();
        if (this.size + bytes > o.maxSize) {
          await this.rotateSizeGenerations(o.maxFiles);
          this.size = 0;
          this.sizeInitialized = true;
        }
        return;
      }

      case 'rotate-time': {
        const stamp = timeStamp(now, o.unit);
        if (this.currentStamp === undefined) {
          this.currentStamp = stamp;
          this.activePath = this.stampPath(stamp);
          await this.rotateTimeRing(o.maxFiles);
        } else if (stamp !== this.currentStamp) {
          this.currentStamp = stamp;
          await this.closeHandle();
          this.activePath = this.stampPath(stamp);
          await this.rotateTimeRing(o.maxFiles);
        }
        return;
      }

      case 'rotate-custom': {
        const ctx: RotateContext = {
          entry,
          size: this.size,
          time: entry.time ?? new Date().toISOString(),
        };
        if (o.shouldRotate(entry, ctx)) {
          this.seq += 1;
          await this.closeHandle();
          this.activePath = this.customPath(this.seq);
          await this.trimRing(o.maxFiles);
        }
        return;
      }
    }
  }

  private async rotateSizeGenerations(maxFiles: number): Promise<void> {
    await this.closeHandle();
    const gens = maxFiles - 1;
    for (let k = gens; k >= 2; k--) {
      try {
        await rename(this.genPath(k - 1), this.genPath(k));
      } catch {
        /* missing generation — skip */
      }
    }
    try {
      await rename(this.activePath, this.genPath(1));
    } catch {
      /* nothing to rotate yet */
    }
    await this.ensureHandle();
  }

  private async rotateTimeRing(maxFiles?: number): Promise<void> {
    await this.ensureHandle();
    if (maxFiles && maxFiles > 1) {
      await this.trimRing(maxFiles);
    }
  }

  private async trimRing(maxFiles?: number): Promise<void> {
    if (!maxFiles) return;
    // Best-effort: remove the oldest numbered/stamped files beyond the cap.
    // We only enforce a soft cap by deleting files that start with appName
    // and carry a numeric/date suffix we can parse; this is intentionally
    // lenient since custom fileName() shapes are user-defined.
    const fs = await import('node:fs/promises');
    try {
      const entries = (await fs.readdir(this.dir)).filter((f) =>
        f.startsWith(`${this.opts.appName}.`),
      );
      const backups = entries.filter((f) => f !== `${this.opts.appName}.${this.ext}`).sort();
      const excess = backups.length - (maxFiles - 1);
      for (let i = 0; i < excess; i++) {
        await fs.rm(join(this.dir, backups[i]), { force: true }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  private async closeHandle(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }

  // ---- Transport interface -------------------------------------------------

  write(entry: LogEntry, formatted: string): void | Promise<void> {
    if (this.filter && !this.filter(entry)) return; // dropped by filter
    const line = formatted + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    const now = this.now();
    const task = this.queue
      .then(async () => {
        await this.prepare(bytes, entry, now);
        const handle = await this.ensureHandle();
        await handle.write(line);
        this.size += bytes;
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
  }
}
