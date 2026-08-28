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

type Matcher = (path: (string | number)[]) => boolean;

/**
 * Compile a redaction spec into a path matcher.
 *
 * - A bare key (no `.` and no `*`), e.g. `"password"`, matches **any** property
 *   named that way at any depth (the historical behavior — convenient for
 *   common secrets).
 * - A dotted spec, e.g. `"user.password"` or `"*.password"`, matches only the
 *   exact path. `*` matches any single key/array index at that position. Numeric
 *   array indices are matched positionally (`"list.0.id"`).
 */
function compileMatcher(spec: string): Matcher {
  if (!spec.includes('.') && !spec.includes('*')) {
    return (p) => p.length > 0 && p[p.length - 1] === spec;
  }
  const segs = spec.split('.');
  return (p) => {
    if (p.length !== segs.length) return false;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s === '*') continue;
      if (String(p[i]) !== s) return false;
    }
    return true;
  };
}

function redactNode(
  node: unknown,
  path: (string | number)[],
  matchers: Matcher[],
  replacement: unknown,
): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const out: unknown[] = new Array(node.length);
    for (let i = 0; i < node.length; i++) {
      const cp = [...path, i];
      if (matchers.some((m) => m(cp))) {
        out[i] = replacement;
        changed = true;
      } else {
        const r = redactNode(node[i], cp, matchers, replacement);
        out[i] = r;
        if (r !== node[i]) changed = true;
      }
    }
    return changed ? out : node;
  }
  if (node !== null && typeof node === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node as Record<string, unknown>)) {
      const cp = [...path, k];
      const v = (node as Record<string, unknown>)[k];
      if (matchers.some((m) => m(cp))) {
        out[k] = replacement;
        changed = true;
      } else {
        const r = redactNode(v, cp, matchers, replacement);
        out[k] = r;
        if (r !== v) changed = true;
      }
    }
    return changed ? out : node;
  }
  return node;
}

/**
 * Create a processor that redacts sensitive data before formatting. It walks
 * `context`, `metadata` and each element of `args`, replacing any value whose
 * path matches one of `keys` with `replacement` (default `"[REDACTED]"`).
 *
 * Matching is **structural** — the original objects are never mutated; only the
 * branches that actually contain a match are cloned. When nothing matches the
 * entry is returned unchanged (same reference), so the common "no secret" case
 * adds no allocation.
 *
 * @example
 * createRedactProcessor(['password'])            // any `password` at any depth
 * createRedactProcessor(['user.password'])       // only `user.password`
 * createRedactProcessor(['*.token', 'user.*'])   // wildcards
 */
export function createRedactProcessor(
  keys: string[],
  replacement: unknown = '[REDACTED]',
): Processor {
  if (keys.length === 0) return identityProcessor;
  const matchers = keys.map(compileMatcher);
  return (entry) => {
    const context = redactNode(entry.context, [], matchers, replacement) as Record<string, unknown>;
    const metadata = redactNode(entry.metadata, [], matchers, replacement) as Record<
      string,
      unknown
    >;
    let argsChanged = false;
    const args = entry.args.map((a) => {
      const r = redactNode(a, [], matchers, replacement);
      if (r !== a) argsChanged = true;
      return r;
    });
    if (context === entry.context && metadata === entry.metadata && !argsChanged) {
      return entry;
    }
    return { ...entry, context, metadata, args: argsChanged ? args : entry.args };
  };
}
