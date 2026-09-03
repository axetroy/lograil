import type { LogEntry, LogLevelName } from '../types.js';
import type { Filter } from './filter.js';

export interface SamplingOptions {
  /**
   * Probability (0..1) that a sampled-level entry is kept. `1` (default) keeps
   * everything; `0` drops all sampled-level entries. Applied before rate
   * limiting. Sampling is intentionally lossy — only enable it for high-volume,
   * low-value levels (e.g. `debug`/`info`).
   */
  rate?: number;
  /**
   * Restrict sampling to these level names. Entries of other levels always pass
   * through untouched. Omit to sample every level.
   */
  levels?: LogLevelName[];
  /**
   * Maximum entries kept per second (token-bucket refill rate). When set, bursts
   * up to `burst` are allowed, then entries are dropped until tokens refill.
   * Off when unset. Combined with `rate` via logical AND.
   */
  maxPerSecond?: number;
  /** Burst capacity for `maxPerSecond`; defaults to `maxPerSecond`. */
  burst?: number;
}

/**
 * Build a {@link Filter} that drops log entries to reduce volume. Two orthogonal
 * strategies are supported and combined with a logical AND:
 *
 * - **probabilistic** (`rate`): keep each entry with probability `rate`;
 * - **rate limiting** (`maxPerSecond` + `burst`): a token bucket caps throughput
 *   per second, tolerating short bursts.
 *
 * Entries outside `levels` are always kept. Because this is a filter, sampled
 * entries never reach processors, formatters or transports — so sampling is also
 * the cheapest way to cut cost under load.
 *
 * @example
 * ```ts
 * logger.getPipeline().addFilter(
 *   createSampler({ levels: ['debug', 'info'], maxPerSecond: 100, burst: 200 }),
 * );
 * ```
 */
export function createSampler(options: SamplingOptions = {}): Filter {
  const rate = options.rate ?? 1;
  const levelSet = options.levels ? new Set(options.levels) : undefined;
  const maxPerSecond = options.maxPerSecond;
  const capacity = maxPerSecond !== undefined ? (options.burst ?? maxPerSecond) : 0;

  // Short-circuit: when rate is 1 and there is no rate limiting, every entry passes.
  const noOp = rate === 1 && maxPerSecond === undefined;

  // Token-bucket state for rate limiting; lazily initialized on first use.
  let tokens = capacity;
  let lastRefill = 0;

  return (entry: LogEntry): boolean => {
    // Levels not opted into sampling always pass through.
    if (levelSet && !levelSet.has(entry.levelName)) return true;

    // Fast path: no sampling configured — let everything through.
    if (noOp) return true;

    // Probabilistic sampling.
    if (rate < 1 && Math.random() >= rate) return false;

    // Rate limiting (token bucket keyed on the entry's ms timestamp).
    if (maxPerSecond !== undefined) {
      const now = entry.timestamp;
      if (lastRefill === 0) {
        lastRefill = now;
        tokens = capacity;
      } else {
        const elapsed = now - lastRefill;
        if (elapsed > 0) {
          tokens = Math.min(capacity, tokens + (elapsed * maxPerSecond) / 1000);
          lastRefill = now;
        }
      }
      if (tokens >= 1) {
        tokens -= 1;
      } else {
        return false;
      }
    }

    return true;
  };
}
