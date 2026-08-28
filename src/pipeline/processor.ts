import type { LogEntry } from '../types.js';

/**
 * A Processor transforms a log entry before it is formatted. Processors must
 * return (the same or a new) entry. They are useful for enrichment, redaction
 * or normalization.
 */
export type Processor = (entry: LogEntry) => LogEntry;

/**
 * Default processor: returns the entry unchanged.
 */
export const identityProcessor: Processor = (entry) => entry;

export function createRedactProcessor(keys: string[], replacement = '[REDACTED]'): Processor {
  const sensitive = new Set(keys);
  const redact = (obj: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (sensitive.has(k)) {
        out[k] = replacement;
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = redact(v as Record<string, unknown>);
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  return (entry) => ({
    ...entry,
    context: redact(entry.context),
    metadata: redact(entry.metadata),
  });
}
