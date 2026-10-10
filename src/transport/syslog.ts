import type { LogEntry } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';
import { createLineFormatter } from '../pipeline/formatter.js';
import type { Transport } from './transport.js';
import { levelToSyslogPriority } from './os-native.js';
import { execFile, osPlatform } from '../shims/index.js';

// Captured at module load so error reporting never recurses into the logger.
const RAW_CONSOLE_ERROR: (...args: unknown[]) => void =
  typeof console !== 'undefined' && typeof console.error === 'function'
    ? console.error.bind(console)
    : () => {};

/**
 * RFC 5424 facility number. The transport prefixes each message with the
 * syslog PRI byte so a `syslog-ng` / `rsyslog` pipeline can route it.
 */
const DEFAULT_FACILITY = 3; // LOG_DAEMON

export interface SyslogTransportOptions {
  name?: string;
  formatter?: Formatter;
  /**
   * RFC 5424 facility number. Default `3` (daemon).
   */
  facility?: number;
  /**
   * How the record is delivered.
   * - `'local'` (default): spawn `logger -t <tag> -p <priority>` once per
   *   write. The `logger` binary ships on every BSD and Linux system that
   *   installs `syslog-ng` / `rsyslog`. Best default.
   * - `'udp'`: send a raw `<pri>timestamp host tag: msg` datagram to
   *   `host:port` over UDP. Requires no binary; useful when the target is a
   *   network syslog server.
   */
  protocol?: 'local' | 'udp';
  /** Host for UDP mode. Default `localhost`. */
  host?: string;
  /** Port for UDP mode. Default `514`. */
  port?: number;
  /** Tag passed to `logger -t`. Default the transport name. */
  tag?: string;
  /**
   * Path to the `logger` binary. Auto-detects from `PATH` when omitted.
   * Override for non-standard installs.
   */
  loggerPath?: string;
}

/**
 * Writes log entries to the operating system's syslog via the `logger`
 * utility (Unix: `logger` on BSD / Linux). On platforms without a syslog
 * socket or where the `logger` binary is unavailable, the transport reports
 * each write through {@link Transport.onError} and remains non-destructive.
 *
 * The transport is **best-effort**: a missing binary or closed socket is
 * bounded by a circuit-breaker pattern (same as the IPC transports) so a
 * broken sink cannot spam the console.
 *
 * Importable everywhere — it never throws at module load. The write path
 * detects platform availability at first use.
 */
export class SyslogTransport implements Transport {
  readonly name: string;
  readonly formatter: Formatter;
  /** Instance hook, set by the user after construction. */
  onError?: (err: unknown, entry: LogEntry) => void;

  private facility: number;
  private protocol: 'local' | 'udp';
  private host: string;
  private port: number;
  private tag: string;
  private loggerPath: string;

  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private static readonly BREAK_AFTER = 50;
  private static readonly OPEN_MS = 5_000;

  constructor(options: SyslogTransportOptions = {}) {
    this.name = options.name ?? 'syslog';
    this.formatter = options.formatter ?? createLineFormatter();
    this.facility = options.facility ?? DEFAULT_FACILITY;
    this.protocol = options.protocol ?? 'local';
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? 514;
    this.tag = options.tag ?? this.name;
    this.loggerPath = options.loggerPath ?? 'logger';
  }

  private available(): boolean {
    return typeof execFile === 'function' && osPlatform() !== 'browser';
  }

  write(entry: LogEntry, formatted: string): void {
    if (!this.available()) {
      this.reportUnavailable();
      return;
    }
    const pri = this.facility * 8 + levelToSyslogPriority(entry.levelName);

    if (this.protocol === 'local') {
      // `logger -t <tag> -p <facility>.<priority> <message>`
      // (No `-s`: it's non-portable across BSD/POSIX variants.)
      execFile(
        this.loggerPath,
        [
          '-t',
          this.tag,
          '-p',
          `${this.facility}.${levelToSyslogPriority(entry.levelName)}`,
          formatted,
        ],
        {},
        (err) => this.onResult(err, entry),
      );
    } else {
      // UDP: send a raw `<pri>timestamp host tag: msg` datagram. Uses `nc -u`
      // (netcat) when present. On systems without `nc` the write fails and
      // is reported through onError — consider `protocol: 'local'` in that case.
      const ts = entry.time.replace('T', ' ').replace('Z', '');
      const line = `<${pri}>${ts} ${this.host} ${this.tag}: ${formatted}\n`;
      execFile('nc', ['-u', this.host, String(this.port)], { input: line } as never, (err) =>
        this.onResult(err, entry),
      );
    }
  }

  private onResult(err: unknown, entry: LogEntry): void {
    if (!err) {
      this.consecutiveFailures = 0;
      this.breakerOpenUntil = 0;
      return;
    }
    const breakerOpen = this.breakerOpenUntil > 0 && Date.now() < this.breakerOpenUntil;
    this.consecutiveFailures += 1;
    if (breakerOpen) {
      this.breakerOpenUntil = Date.now() + SyslogTransport.OPEN_MS;
      return;
    }
    if (this.consecutiveFailures >= SyslogTransport.BREAK_AFTER) {
      this.breakerOpenUntil = Date.now() + SyslogTransport.OPEN_MS;
      this.consecutiveFailures = 0;
      this.onError?.(err instanceof Error ? err : new Error(String(err)), entry);
    } else if (this.consecutiveFailures === 1) {
      RAW_CONSOLE_ERROR(`[lograil] syslog transport (${this.name}) write failed:`, err);
    }
  }

  private reportUnavailable(): void {
    const breakerOpen = this.breakerOpenUntil > 0 && Date.now() < this.breakerOpenUntil;
    if (breakerOpen) {
      this.breakerOpenUntil = Date.now() + SyslogTransport.OPEN_MS;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= SyslogTransport.BREAK_AFTER) {
      this.breakerOpenUntil = Date.now() + SyslogTransport.OPEN_MS;
      this.consecutiveFailures = 0;
      this.onError?.(new Error('syslog transport: not available on this platform'), {} as LogEntry);
    }
  }

  close(): void {
    /* No persistent resources to release; the logger utility is stateless. */
  }
}
