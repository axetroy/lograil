import type { LogEntry } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';
import { createLineFormatter } from '../pipeline/formatter.js';
import type { Transport } from './transport.js';
import { execFile, osPlatform } from '../shims/index.js';

// Captured at module load so error reporting never recurses into the logger.
const RAW_CONSOLE_ERROR: (...args: unknown[]) => void =
  typeof console !== 'undefined' && typeof console.error === 'function'
    ? console.error.bind(console)
    : () => {};

export interface WindowsEventLogTransportOptions {
  name?: string;
  formatter?: Formatter;
  /**
   * Event Log name (e.g. `Application`, `System`, or a custom log created via
   * `wevtutil`). Default is the transport name.
   */
  log?: string;
  /**
   * Source / provider string recorded with the event. Default the transport name.
   * Must be registered on the system for custom logs.
   */
  source?: string;
  /**
   * Event ID assigned to the record. Default `1`.
   * You can override per-entry by setting `entry.metadata.wevtid` to a number.
   */
  eventId?: number;
}

/**
 * Writes log entries to the Windows Event Log via `eventcreate.exe` (built into
 * Windows Vista / 7 / Server 2008 and later). On non-Windows platforms or in
 * browser builds the transport is importable but each write is reported through
 * {@link Transport.onError} — bounded by a circuit breaker so a broken sink
 * cannot spam the console.
 *
 * **Custom event sources**: for a custom `source`, the Windows event system
 * requires the source to be registered under `HKLM\SOFTWARE\Microsoft\Windows
 * \CurrentVersion\EventLog\<log>` first. The transport will surface the
 * error via `onError` until the source exists.
 *
 * **Permissions**: writing to `Application` or `System` logs requires
 * administrative privileges. Without them the writes will fail silently
 * (reported once per breaker window).
 */
export class WindowsEventLogTransport implements Transport {
  readonly name: string;
  readonly formatter: Formatter;
  /** Instance hook, set by the user after construction. */
  onError?: (err: unknown, entry: LogEntry) => void;

  private log: string;
  private source: string;
  private eventId: number;

  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private static readonly BREAK_AFTER = 10;
  private static readonly OPEN_MS = 5_000;

  constructor(options: WindowsEventLogTransportOptions = {}) {
    this.name = options.name ?? 'windows-event-log';
    this.formatter = options.formatter ?? createLineFormatter();
    this.log = options.log ?? this.name;
    this.source = options.source ?? this.name;
    this.eventId = options.eventId ?? 1;
  }

  private available(): boolean {
    return typeof execFile === 'function' && osPlatform() === 'win32';
  }

  write(entry: LogEntry, formatted: string): void {
    if (!this.available()) {
      this.reportUnavailable();
      return;
    }
    const id =
      typeof entry.metadata?.wevtid === 'number' ? (entry.metadata.wevtid as number) : this.eventId;
    // `eventcreate /t <type> /l <log> /s <source> /d <data> /id <id>`
    // -t is "error" or "information" (Windows Event Log type)
    // -s is the source string
    // -d is the message body
    const type =
      entry.levelName === 'error' || entry.levelName === 'fatal' ? 'error' : 'information';
    execFile(
      'eventcreate.exe',
      ['/t', type, '/l', this.log, '/s', this.source, '/d', formatted, '/id', String(id)],
      {},
      (err) => this.onResult(err, entry),
    );
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
      this.breakerOpenUntil = Date.now() + WindowsEventLogTransport.OPEN_MS;
      return;
    }
    if (this.consecutiveFailures >= WindowsEventLogTransport.BREAK_AFTER) {
      this.breakerOpenUntil = Date.now() + WindowsEventLogTransport.OPEN_MS;
      this.consecutiveFailures = 0;
      this.onError?.(err instanceof Error ? err : new Error(String(err)), entry);
    } else if (this.consecutiveFailures === 1) {
      RAW_CONSOLE_ERROR(`[lograil] windows-event-log transport (${this.name}) write failed:`, err);
    }
  }

  private reportUnavailable(): void {
    const breakerOpen = this.breakerOpenUntil > 0 && Date.now() < this.breakerOpenUntil;
    if (breakerOpen) {
      this.breakerOpenUntil = Date.now() + WindowsEventLogTransport.OPEN_MS;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= WindowsEventLogTransport.BREAK_AFTER) {
      this.breakerOpenUntil = Date.now() + WindowsEventLogTransport.OPEN_MS;
      this.consecutiveFailures = 0;
      this.onError?.(
        new Error('windows-event-log transport: not available on this platform'),
        {} as LogEntry,
      );
    }
  }

  close(): void {
    /* No persistent resources to release; eventcreate is stateless. */
  }
}
