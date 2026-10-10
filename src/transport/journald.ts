import type { LogEntry } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';
import { createLineFormatter } from '../pipeline/formatter.js';
import type { Transport } from './transport.js';
import { spawn, osPlatform } from '../shims/index.js';
// Captured at module load so error reporting never recurses into the logger.
const RAW_CONSOLE_ERROR: (...args: unknown[]) => void =
  typeof console !== 'undefined' && typeof console.error === 'function'
    ? console.error.bind(console)
    : () => {};

/**
 * Minimal structural view of the `ChildProcess` we actually use, so the
 * transport (and its browser stub) never depends on the full `node:` type.
 */
interface JournaldChild {
  stdin: {
    write(s: string, cb?: (err: Error | null) => void): boolean;
    on(ev: string, cb: (...a: unknown[]) => void): unknown;
  };
  on(ev: string, cb: (...a: unknown[]) => void): unknown;
  kill(): void;
}

export interface JournaldTransportOptions {
  name?: string;
  formatter?: Formatter;
  /**
   * Extra key=value fields appended to every journal record. Useful for
   * tagging with app name, deployment env, etc. `IDENTIFIER` is defaulted
   * to the transport name when omitted.
   */
  fields?: Record<string, string>;
  /**
   * Fixed `PRIORITY` journal field. When unset, the entry's level is mapped
   * to a syslog priority.
   */
  priority?: number;
}

/**
 * Writes log entries to the systemd journal via a persistent `systemd-cat`
 * process (Linux / systemd hosts). `systemd-cat` is a stable, documented
 * interface: it reads newline-delimited lines from stdin and forwards each
 * to the journal, applying the `KEY=VALUE` arguments as fixed fields.
 *
 * The transport is **best-effort**: on platforms without `systemd-cat`
 * (or in a browser build where the shim is a stub) the spawn fails and each
 * write is reported through {@link Transport.onError}, bounded by a
 * circuit breaker so a broken sink cannot spam the console. The helper is
 * importable everywhere — it never throws at module load.
 */
export class JournaldTransport implements Transport {
  readonly name: string;
  readonly formatter: Formatter;
  /** Instance hook, set by the user after construction. */
  onError?: (err: unknown, entry: LogEntry) => void;

  private fields: Record<string, string>;
  private fixedPriority?: number;

  private child: JournaldChild | undefined;
  private starting = false;
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private static readonly BREAK_AFTER = 10;
  private static readonly OPEN_MS = 5_000;

  constructor(options: JournaldTransportOptions = {}) {
    this.name = options.name ?? 'journald';
    this.formatter = options.formatter ?? createLineFormatter();
    this.fields = { IDENTIFIER: this.name, ...options.fields };
    this.fixedPriority = options.priority;
  }

  private available(): boolean {
    return typeof spawn === 'function' && osPlatform() !== 'browser';
  }

  /** Spawn (once) a persistent `systemd-cat` with the fixed fields. */
  private ensureProcess(cb: (err: Error | null) => void): void {
    if (this.child) {
      cb(null);
      return;
    }
    if (this.starting) {
      cb(new Error('journald: helper still starting'));
      return;
    }
    this.starting = true;
    const args: string[] = [];
    for (const [k, v] of Object.entries(this.fields)) args.push(`${k}=${v}`);
    args.push(`PRIORITY=${this.fixedPriority ?? 6}`);
    args.push('-'); // read log lines from stdin
    let child: JournaldChild;
    try {
      child = spawn('systemd-cat', args, {
        stdio: ['pipe', 'inherit', 'inherit'],
      }) as unknown as JournaldChild;
    } catch (err) {
      this.starting = false;
      this.onSpawnError(err, cb);
      return;
    }
    child.on('error', (err) => {
      if (this.child === child) this.child = undefined;
      this.starting = false;
      this.consecutiveFailures += 1;
      cb(err instanceof Error ? err : new Error(String(err)));
    });
    child.on('exit', (code: unknown) => {
      if (this.child === child) this.child = undefined;
      this.starting = false;
      if (typeof code === 'number' && code !== 0) {
        this.consecutiveFailures += 1;
      }
    });
    this.child = child;
    this.starting = false;
    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
    cb(null);
  }

  private onSpawnError(err: unknown, cb: (e: Error | null) => void): void {
    const e = err instanceof Error ? err : new Error(String(err));
    const breakerOpen = this.breakerOpenUntil > 0 && Date.now() < this.breakerOpenUntil;
    this.consecutiveFailures += 1;
    if (!breakerOpen && this.consecutiveFailures >= JournaldTransport.BREAK_AFTER) {
      this.breakerOpenUntil = Date.now() + JournaldTransport.OPEN_MS;
      this.consecutiveFailures = 0;
      this.onError?.(e, {} as LogEntry);
    } else if (this.consecutiveFailures === 1) {
      RAW_CONSOLE_ERROR(
        `[lograil] journald transport (${this.name}): failed to start systemd-cat`,
        e,
      );
    }
    cb(e);
  }

  write(entry: LogEntry, formatted: string): void {
    if (!this.available()) {
      this.reportUnavailable(entry);
      return;
    }
    const line = formatted;
    this.ensureProcess((err) => {
      if (err) return; // reported inside ensureProcess / onSpawnError
      try {
        this.child!.stdin.write(line + '\n', (writeErr) => {
          if (writeErr) this.onWriteFailure(entry);
          else {
            this.consecutiveFailures = 0;
            this.breakerOpenUntil = 0;
          }
        });
      } catch {
        this.onWriteFailure(entry);
      }
    });
  }

  private onWriteFailure(entry: LogEntry): void {
    const breakerOpen = this.breakerOpenUntil > 0 && Date.now() < this.breakerOpenUntil;
    this.consecutiveFailures += 1;
    if (breakerOpen) {
      this.breakerOpenUntil = Date.now() + JournaldTransport.OPEN_MS;
      return;
    }
    if (this.consecutiveFailures >= JournaldTransport.BREAK_AFTER) {
      this.breakerOpenUntil = Date.now() + JournaldTransport.OPEN_MS;
      this.consecutiveFailures = 0;
      this.onError?.(new Error('journald: systemd-cat write failed'), entry);
    }
  }

  private reportUnavailable(entry: LogEntry): void {
    const breakerOpen = this.breakerOpenUntil > 0 && Date.now() < this.breakerOpenUntil;
    if (breakerOpen) {
      this.breakerOpenUntil = Date.now() + JournaldTransport.OPEN_MS;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= JournaldTransport.BREAK_AFTER) {
      this.breakerOpenUntil = Date.now() + JournaldTransport.OPEN_MS;
      this.consecutiveFailures = 0;
      this.onError?.(
        new Error('journald transport: systemd-cat not available on this platform'),
        entry,
      );
    }
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }
}
