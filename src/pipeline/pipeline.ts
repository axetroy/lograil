import type { LogEntry } from '../types.js';
import type { Filter } from './filter.js';
import { combineFilters } from './filter.js';
import type { Processor } from './processor.js';
import type { Formatter } from './formatter.js';

export interface PipelineOptions {
  filters?: Filter[];
  processors?: Processor[];
  formatter?: Formatter;
}

/**
 * The processing pipeline sits between the Logger (entry creation) and the
 * Transports (output). For each entry it:
 *
 *   1. runs all {@link Filter}s — if any returns `false` the entry is dropped;
 *   2. runs all {@link Processor}s in order, allowing enrichment / redaction;
 *   3. exposes a {@link Formatter} used by transports to serialize the entry.
 */
export class Pipeline {
  private filters: Filter[];
  private processors: Processor[];
  private formatter: Formatter;
  private cachedFilter: Filter | undefined = undefined;
  /**
   * Error sink for a throwing {@link Filter} or {@link Processor}. The logger
   * wires this to its own global error handler; when unset, the throw is simply
   * swallowed and the entry proceeds unchanged (for processors) or is dropped
   * (for filters).
   */
  onError?: (err: unknown, info: { phase: 'filter' | 'process'; entry: LogEntry }) => void;

  constructor(options: PipelineOptions = {}) {
    this.filters = options.filters ? [...options.filters] : [];
    this.processors = options.processors ? [...options.processors] : [];
    this.formatter = options.formatter ?? ((e: LogEntry) => e as unknown as string);
  }

  addFilter(filter: Filter): void {
    this.filters.push(filter);
    this.cachedFilter = undefined;
  }

  addProcessor(processor: Processor): void {
    this.processors.push(processor);
  }

  removeFilter(filter: Filter): void {
    const i = this.filters.indexOf(filter);
    if (i >= 0) this.filters.splice(i, 1);
    this.cachedFilter = undefined;
  }

  removeProcessor(processor: Processor): void {
    const i = this.processors.indexOf(processor);
    if (i >= 0) this.processors.splice(i, 1);
  }

  setFormatter(formatter: Formatter): void {
    this.formatter = formatter;
  }

  getFormatter(): Formatter {
    return this.formatter;
  }

  /**
   * Run filters and processors. Returns `null` when the entry is filtered out.
   */
  process(entry: LogEntry): LogEntry | null {
    const original = entry;
    if (this.filters.length) {
      if (this.cachedFilter === undefined) {
        this.cachedFilter =
          this.filters.length === 1 ? this.filters[0] : combineFilters(this.filters);
      }
      try {
        if (!this.cachedFilter(entry)) {
          return null;
        }
      } catch (err) {
        this.onError?.(err, { phase: 'filter', entry });
        return null;
      }
    }
    let current = entry;
    for (const processor of this.processors) {
      try {
        current = processor(current);
      } catch (err) {
        // A broken processor must not crash logging. Keep the last good entry
        // and continue with the remaining processors.
        this.onError?.(err, { phase: 'process', entry: original });
      }
      if (!current) return null;
    }
    return current;
  }
}
