import { mkdir, open, rename, stat, truncate } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import type { LogEntry } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';
import { createJsonFormatter } from '../pipeline/formatter.js';
import type { Transport } from './transport.js';

export interface RotatingFileTransportOptions {
  /** Active (or current-day) log file path, e.g. `/var/log/app.log`. */
  path: string;
  /** Size mode: rotate once the active file exceeds this size in bytes. */
  maxSize?: number;
  /**
   * Maximum number of files in the rotation set.
   *  - Size mode: `app.log` + `app.1.log` … (generations). Minimum 2.
   *  - Daily mode: `{name}.{YYYY-MM-DD}.01..{maxFiles}.log` per day; when the
   *    index would pass `maxFiles` it wraps back to `01` and clears that file.
   *    Defaults to 5 (size) or 99 (daily).
   */
  maxFiles?: number;
  /**
   * Daily mode (default `true`): one dated file per day, split into
   * `01`..`{maxFiles}` indexes. Set `false` for plain size-based generation
   * rotation (`app.log` → `app.1.log` → …) without dates.
   */
  daily?: boolean;
  /** Override the clock (mainly for testing). Defaults to `new Date()`. */
  now?: () => Date;
  formatter?: Formatter;
  name?: string;
}

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_MAX_FILES_DAILY = 99;

function dateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * File transport with rotation, for the Electron main process (Node.js).
 *
 * Two modes:
 *  - **Daily** (default): the active file is
 *    `{name}.{YYYY-MM-DD}.{index}.log`, where `index` runs `01`..`maxFiles`
 *    (default 99). When it would pass `maxFiles` it wraps back to `01` and
 *    that file is cleared — a `maxFiles`-file ring buffer per day. When the
 *    local day changes, the index resets to `01` for the new day.
 */
export class RotatingFileTransport implements Transport {
  readonly name: string;
  readonly formatter: Formatter;
  private readonly path: string;
  private readonly maxSize: number;
  private readonly maxFiles: number;
  private readonly daily: boolean;
  private readonly now: () => Date;
  private handle: Awaited<ReturnType<typeof open>> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private size = 0;
  private sizeInitialized = false;
  private currentDate: string | undefined;
  private index = 1;

  constructor(options: RotatingFileTransportOptions) {
    if (!options.path) {
      throw new Error('RotatingFileTransport requires a "path"');
    }
    this.path = options.path;
    this.daily = options.daily ?? true;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.maxFiles = options.maxFiles ?? (this.daily ? DEFAULT_MAX_FILES_DAILY : DEFAULT_MAX_FILES);
    if (!this.daily) {
      this.maxFiles = Math.max(2, this.maxFiles);
    } else {
      this.maxFiles = Math.max(1, this.maxFiles);
    }
    this.now = options.now ?? (() => new Date());
    this.name = options.name ?? `rotating-file:${options.path}`;
    this.formatter = options.formatter ?? createJsonFormatter();
  }

  private activePath(): string {
    if (!this.daily) {
      return this.path;
    }
    const ext = extname(this.path);
    const base = ext ? this.path.slice(0, -ext.length) : this.path;
    const idx = String(this.index).padStart(2, '0');
    return `${base}.${this.currentDate}.${idx}${ext}`;
  }

  private async ensureHandle(): Promise<void> {
    if (!this.handle) {
      await mkdir(dirname(this.activePath()), { recursive: true });
      this.handle = await open(this.activePath(), 'a');
    }
  }

  private async ensureSize(): Promise<void> {
    if (this.sizeInitialized) return;
    try {
      const st = await stat(this.activePath());
      this.size = st.size;
    } catch {
      this.size = 0;
    }
    this.sizeInitialized = true;
  }

  private async rotateSize(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
    const gens = this.maxFiles - 1;
    for (let k = gens; k >= 2; k--) {
      try {
        await rename(`${this.path}.${k - 1}`, `${this.path}.${k}`);
      } catch {
        /* generation missing — skip */
      }
    }
    try {
      await rename(this.path, `${this.path}.1`);
    } catch {
      /* nothing to rotate yet */
    }
    this.size = 0;
    this.sizeInitialized = true;
    await this.ensureHandle();
  }

  /**
   * Move to a new index file. When `clear` is true the target file is
   * truncated first (used both for normal index advancement and for the
   * wrap-to-01, which must clear the stale `01` slot).
   */
  private async rotateToIndex(idx: number, clear: boolean): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
    this.index = idx;
    if (clear) {
      try {
        await truncate(this.activePath(), 0);
      } catch {
        /* file did not exist yet — fine */
      }
      this.size = 0;
      this.sizeInitialized = true;
    }
    await this.ensureHandle();
    if (!clear) {
      await this.ensureSize();
    }
  }

  write(_entry: LogEntry, formatted: string): void | Promise<void> {
    const line = formatted + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    const task = this.queue
      .then(async () => {
        if (!this.daily) {
          await this.ensureSize();
          if (this.size + bytes > this.maxSize) {
            await this.rotateSize();
          }
        } else {
          const today = dateStamp(this.now());
          if (this.currentDate === undefined || today !== this.currentDate) {
            // First open, or a new day: reset to index 01 (resume/append).
            this.currentDate = today;
            this.index = 1;
            await this.rotateToIndex(1, false);
          } else {
            await this.ensureSize();
            if (this.size + bytes > this.maxSize) {
              let next = this.index + 1;
              if (next > this.maxFiles) {
                next = 1; // wrap and clear the 01 slot
              }
              await this.rotateToIndex(next, true);
            }
          }
        }
        await this.ensureHandle();
        await this.handle!.write(line);
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
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }
}
