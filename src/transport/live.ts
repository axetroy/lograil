import type { LogEntry } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';
import type { Transport } from './transport.js';

/** A subscriber callback invoked for every entry the transport receives. */
export type LiveSubscriber = (entry: LogEntry) => void;

export interface LiveTransportOptions {
  /** Transport name. */
  name?: string;
  /**
   * Optional per-transport formatter. The formatted string is computed lazily
   * only when a subscriber actually requests it via {@link LiveTransport.onFormatted};
   * plain {@link LiveTransport.subscribe} subscribers receive the raw entry.
   */
  formatter?: Formatter;
  /**
   * Maximum number of buffered entries kept for late subscribers (see
   * {@link LiveTransport.replay}). `0` disables buffering. Defaults to `0`.
   */
  bufferSize?: number;
}

/**
 * An in-memory, subscribable transport. Instead of writing to a file, console
 * or the network, it forwards every entry to in-process subscribers — making it
 * the building block for **live log streaming** (e.g. a debug panel, a webview
 * log viewer, or a React/Vue hook that renders the stream).
 *
 * It is zero-dependency and works in every runtime (Web, Node, Electron). For
 * cross-process streaming (Electron main → renderer/webview) pair it with the
 * existing IPC channel, or use {@link BroadcastChannelTransport} for cross-tab
 * Web streaming.
 *
 * Entries arrive already frozen (the immutability contract), so subscribers
 * receive a read-only, zero-copy reference — never mutate them.
 *
 * @example
 * const live = new LiveTransport();
 * logger.addTransport(live);
 * const unsubscribe = live.subscribe((entry) => render(entry));
 */
export class LiveTransport implements Transport {
  readonly name: string;
  readonly formatter?: Formatter;

  private subscribers = new Set<LiveSubscriber>();
  private buffer: LogEntry[] = [];
  private readonly bufferSize: number;

  constructor(options: LiveTransportOptions = {}) {
    this.name = options.name ?? 'live';
    this.formatter = options.formatter;
    this.bufferSize = options.bufferSize ?? 0;
  }

  write(entry: LogEntry): void {
    if (this.subscribers.size === 0) {
      this.pushBuffer(entry);
      return;
    }
    for (const sub of this.subscribers) {
      try {
        sub(entry);
      } catch (err) {
        // A misbehaving subscriber must never break the logger's hot path.
        console.error('[lograil] LiveTransport subscriber threw:', err);
      }
    }
    this.pushBuffer(entry);
  }

  /**
   * Subscribe to live entries. Returns an unsubscribe function. The callback
   * receives the raw, frozen {@link LogEntry}.
   */
  subscribe(cb: LiveSubscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * Subscribe to entries as pre-formatted strings (using the transport's
   * formatter, or the default line formatter when none is set). Convenient for
   * UIs that just want to append text lines.
   */
  onFormatted(cb: (line: string, entry: LogEntry) => void): () => void {
    const format = this.formatter;
    return this.subscribe((entry) => {
      const line = format ? format(entry) : entry.message;
      cb(line, entry);
    });
  }

  /**
   * Replay buffered entries to a new subscriber (most-recent-first when
   * `newestFirst` is true). Only available when `bufferSize > 0`. Returns the
   * number of entries replayed.
   */
  replay(cb: LiveSubscriber, newestFirst = false): number {
    if (this.buffer.length === 0) return 0;
    const entries = newestFirst ? [...this.buffer].reverse() : this.buffer;
    for (const entry of entries) cb(entry);
    return entries.length;
  }

  /** Number of active subscribers. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Drop all buffered entries. */
  clearBuffer(): void {
    this.buffer = [];
  }

  private pushBuffer(entry: LogEntry): void {
    if (this.bufferSize <= 0) return;
    this.buffer.push(entry);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.splice(0, this.buffer.length - this.bufferSize);
    }
  }

  close(): void {
    this.subscribers.clear();
    this.buffer = [];
  }
}
