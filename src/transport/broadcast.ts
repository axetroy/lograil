import type { LogEntry } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';
import { createLineFormatter } from '../pipeline/formatter.js';
import type { Transport } from './transport.js';

/**
 * Minimal structural view of the `BroadcastChannel` global. Declared here
 * (rather than imported from a DOM lib) so the transport compiles under the
 * Node type target and still type-checks the real global in browser builds.
 */
interface BroadcastChannelLike {
  name: string;
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

function getBroadcastChannelCtor(): (new (name: string) => BroadcastChannelLike) | undefined {
  const g = globalThis as { BroadcastChannel?: unknown };
  if (typeof g.BroadcastChannel === 'function') {
    return g.BroadcastChannel as new (name: string) => BroadcastChannelLike;
  }
  return undefined;
}

export interface BroadcastChannelTransportOptions {
  /**
   * The BroadcastChannel name. All tabs / windows that share this name and
   * origin will receive each other's log entries. Default `'lograil'`.
   */
  name?: string;
  /**
   * Transport name (distinct from the channel name). Default
   * `'broadcast-channel'`.
   */
  transportName?: string;
  formatter?: Formatter;
}

/**
 * Cross-tab / cross-window Web streaming transport. Each tab that
 * `addTransport(new BroadcastChannelTransport())` creates a `BroadcastChannel`
 * and posts every entry to it; every other tab with the same channel name
 * and origin receives the entry via the `subscribe()` callback (or via
 * `registerBroadcastChannelReceiver`).
 *
 * The transport is importable in every runtime. On platforms without
 * `BroadcastChannel` (Node, older browsers, Electron main), `write` is a
 * no-op and `subscribe` callbacks are never invoked — no crash, no error.
 *
 * **Use case:** a multi-tab web app where each tab is a separate JS context.
 * Combine with {@link LiveTransport} on the receiving side to render the
 * stream, or feed received entries back into the receiving logger for
 * unified file / console output.
 *
 * @example
 * ```ts
 * import { BroadcastChannelTransport, registerBroadcastChannelReceiver } from 'lograil';
 *
 * const log = createLogger({
 *   transports: [new ConsoleTransport(), new BroadcastChannelTransport()],
 * });
 * log.info('from tab A'); // also visible in tab B
 *
 * // In tab B (the receiving side):
 * const off = registerBroadcastChannelReceiver((entry) => log.ingestEntry(entry));
 * ```
 */
export class BroadcastChannelTransport implements Transport {
  readonly name: string;
  readonly formatter: Formatter;
  /** Instance hook, set by the user after construction. */
  onError?: (err: unknown, entry: LogEntry) => void;

  private channelName: string;
  private channel: BroadcastChannelLike | undefined;
  private subscribers = new Set<(entry: LogEntry) => void>();

  constructor(options: BroadcastChannelTransportOptions = {}) {
    this.name = options.transportName ?? 'broadcast-channel';
    this.formatter = options.formatter ?? createLineFormatter();
    this.channelName = options.name ?? 'lograil';
  }

  private ensureChannel(): boolean {
    if (this.channel) return true;
    const Ctor = getBroadcastChannelCtor();
    if (!Ctor) return false;
    try {
      this.channel = new Ctor(this.channelName);
      this.channel.onmessage = (event) => {
        const data = event.data;
        if (
          data &&
          typeof data === 'object' &&
          (data as Record<string, unknown>).__lograilBroadcast === true &&
          'entry' in data
        ) {
          for (const cb of this.subscribers) {
            try {
              cb(data.entry as LogEntry);
            } catch {
              /* a subscriber that throws must not break others */
            }
          }
        }
      };
      return true;
    } catch {
      this.channel = undefined;
      return false;
    }
  }

  /**
   * Subscribe to entries that *this* transport's channel receives from other
   * tabs. Returns an unsubscribe function. On platforms without
   * `BroadcastChannel`, the callback is never invoked.
   */
  subscribe(cb: (entry: LogEntry) => void): () => void {
    this.subscribers.add(cb);
    this.ensureChannel();
    return () => {
      this.subscribers.delete(cb);
    };
  }

  write(entry: LogEntry, _formatted: string): void {
    if (!this.ensureChannel()) return;
    try {
      this.channel!.postMessage({ __lograilBroadcast: true, entry });
    } catch (err) {
      this.onError?.(err, entry);
    }
  }

  close(): void {
    this.channel?.close();
    this.channel = undefined;
    this.subscribers.clear();
  }
}

/**
 * Convenience receiver for the *receiving* side. Equivalent to
 * `new BroadcastChannelTransport({ name }).subscribe(ingest)` but returns an
 * unregister function and does not require a full transport instance.
 */
export function registerBroadcastChannelReceiver(
  ingest: (entry: LogEntry) => void,
  options: { name?: string; transportName?: string } = {},
): () => void {
  const t = new BroadcastChannelTransport({
    transportName: options.transportName ?? 'bc-receiver',
    name: options.name,
  });
  return t.subscribe(ingest);
}
