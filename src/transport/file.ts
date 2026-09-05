import { mkdir, open, stat, readdir } from '../shims/index.js';
import { basename, dirname, join } from '../shims/index.js';
import { tmpdir } from '../shims/index.js';
import type { LogEntry } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';
import { createJsonFormatter } from '../pipeline/formatter.js';
import type { Transport } from './transport.js';
import type {
  FileTransportOptions,
  FileIo,
  Rotator,
  GetFilesOptions,
  FileMeta,
} from './file-rotator.js';
import { createRotator, enforceGlobalCaps } from './file-rotator.js';

// Re-export all rotator types, classes, and helpers from file-rotator.js
export {
  FileBaseOptions,
  SingleAppendOptions,
  SingleTruncateOptions,
  RotateSizeOptions,
  RotateTimeOptions,
  RotateContext,
  RotateCustomOptions,
  FileTransportOptions,
  FileMeta,
  GetFilesOptions,
  Rotator,
  FileIo,
  SingleRotator,
  TruncateRotator,
  SizeRotator,
  TimeRotator,
  CustomRotator,
  trimTimeRing,
  enforceGlobalCaps,
  createRotator,
} from './file-rotator.js';

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

    this.rotator = createRotator(options, this.dir, this.ext);

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
