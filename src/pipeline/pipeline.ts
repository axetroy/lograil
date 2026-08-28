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
    if (this.filters.length) {
      if (this.cachedFilter === undefined) {
        this.cachedFilter =
          this.filters.length === 1 ? this.filters[0] : combineFilters(this.filters);
      }
      if (!this.cachedFilter(entry)) {
        return null;
      }
    }
    let current = entry;
    for (const processor of this.processors) {
      current = processor(current);
    }
    return current;
  }
}
