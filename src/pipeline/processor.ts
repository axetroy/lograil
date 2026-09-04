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

/**
 * Recursively walk a value, replacing any node whose path matches one of
 * `matchers` with `replacement`. Returns the original reference when nothing
 * matched (structural equality), so callers can short-circuit without cloning.
 *
 * @param node   The value to walk (array, plain object, or primitive)
 * @param path   Current path accumulator — mutated in place via push/pop
 * @param matchers List of path-matchers; a match triggers replacement
 * @param replacement Value to insert in place of a matched node
 */
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
      path.push(i);
      if (matchers.some((m) => m(path))) {
        out[i] = replacement;
        changed = true;
      } else {
        const r = redactNode(node[i], path, matchers, replacement);
        out[i] = r;
        if (r !== node[i]) changed = true;
      }
      path.pop();
    }
    return changed ? out : node;
  }
  if (node !== null && typeof node === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node as Record<string, unknown>)) {
      path.push(k);
      const v = (node as Record<string, unknown>)[k];
      if (matchers.some((m) => m(path))) {
        out[k] = replacement;
        changed = true;
      } else {
        const r = redactNode(v, path, matchers, replacement);
        out[k] = r;
        if (r !== v) changed = true;
      }
      path.pop();
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
/**
 * Common secret / PII key names redacted by {@link createRedactProcessor} when
 * no explicit key list is supplied. Covers passwords, tokens, API keys, auth
 * headers, cookies, private keys and a few PII fields.
 */
/** All canonical forms of this list — the public entry point for `createRedactProcessor`. */
export const DEFAULT_SENSITIVE_KEYS: string[] = [
  // authentication & credentials
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'accessToken',
  'access_token_value',
  'refreshToken',
  'apiKey',
  'api_key_value',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'setCookie',
  'credentials',
  'credential',
  'privateKey',
  'private_key_value',
  // session & identity
  'sessionId',
  'session',
  'csrfToken',
  'csrf',
  'otp',
  'ssn',
  // API / service keys
  'appKey',
  'appSecret',
  'clientKey',
  'clientSecret',
  'publishableKey',
  'secretKey',
  'webhookSecret',
  'signature',
  // payment
  'cvv',
  'pin',
  // header-style flat names (X- prefixed or well-known auth headers)
  'xApiKey',
  'xApiToken',
  'xAuth',
  'xForwardedFor',
];

/** Snake-case variant of {@link DEFAULT_SENSITIVE_KEYS}. */
export const DEFAULT_SENSITIVE_KEYS_SNAKE: string[] = DEFAULT_SENSITIVE_KEYS.map(toSnakeCase);

/** Kebab-case variant of {@link DEFAULT_SENSITIVE_KEYS}. */
export const DEFAULT_SENSITIVE_KEYS_KEBAB: string[] = DEFAULT_SENSITIVE_KEYS.map(toKebabCase);

/** Convert `camelCase` to `snake_case` (no-op for already-snake or flat words). */
function toSnakeCase(s: string): string {
  return s.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/** Convert `camelCase` to `kebab-case` (no-op for already-kebab or flat words). */
function toKebabCase(s: string): string {
  return s.replace(/([A-Z])/g, '-$1').toLowerCase();
}

export function createRedactProcessor(
  keys: string[] = DEFAULT_SENSITIVE_KEYS,
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

/**
 * A Serializer transforms a single value keyed by `name` before formatting.
 * `entry` is passed for contextual serialization (e.g. capturing the level).
 */
export type Serializer = (value: unknown, entry: LogEntry) => unknown;

function serializeNode(
  node: unknown,
  serializers: Record<string, Serializer>,
  entry: LogEntry,
): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const out: unknown[] = new Array(node.length);
    for (let i = 0; i < node.length; i++) {
      const r = serializeNode(node[i], serializers, entry);
      out[i] = r;
      if (r !== node[i]) changed = true;
    }
    return changed ? out : node;
  }
  if (node !== null && typeof node === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node as Record<string, unknown>)) {
      const v = (node as Record<string, unknown>)[k];
      if (serializers[k]) {
        out[k] = serializers[k](v, entry);
        changed = true;
      } else {
        const r = serializeNode(v, serializers, entry);
        out[k] = r;
        if (r !== v) changed = true;
      }
    }
    return changed ? out : node;
  }
  return node;
}

/**
 * Create a processor that normalizes values by key name before formatting. For
 * every property named `key` found in `context`, `metadata`, each element of
 * `args` (and the entry's `error`), the matching serializer replaces the value.
 * Matching is by property name at **any depth** (e.g. a `req` serializer runs on
 * any object that has a `req` property).
 *
 * Transformation is **structural** — only the branches that contain a matching
 * key are cloned; when no serializer fires the entry is returned unchanged (same
 * reference), so the common "no serializer matched" case adds no allocation.
 *
 * @example
 * createSerializeProcessor({
 *   err: (e) => ({ name: e.name, message: e.message, stack: e.stack }),
 *   user: (u) => ({ id: u.id }), // drop the rest of the user object
 * })
 */
export function createSerializeProcessor(serializers: Record<string, Serializer>): Processor {
  if (!serializers || Object.keys(serializers).length === 0) return identityProcessor;
  return (entry) => {
    const context = serializeNode(entry.context, serializers, entry) as Record<string, unknown>;
    const metadata = serializeNode(entry.metadata, serializers, entry) as Record<string, unknown>;
    let argsChanged = false;
    const args = entry.args.map((a) => {
      const r = serializeNode(a, serializers, entry);
      if (r !== a) argsChanged = true;
      return r;
    });
    let error = entry.error;
    let errorChanged = false;
    if (error !== undefined && serializers['error']) {
      const r = serializers['error'](error, entry);
      if (r !== error) {
        error = r as Error;
        errorChanged = true;
      }
    }
    if (context === entry.context && metadata === entry.metadata && !argsChanged && !errorChanged) {
      return entry;
    }
    return {
      ...entry,
      context,
      metadata,
      args: argsChanged ? args : entry.args,
      ...(errorChanged ? { error } : {}),
    };
  };
}

function serializeErrorValue(v: unknown): unknown {
  return v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
}

function serializeBufferValue(v: unknown): unknown {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return `Buffer(${v.length})`;
  if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength})`;
  if (ArrayBuffer.isView(v)) {
    return `${v.constructor.name}(${(v as { byteLength: number }).byteLength})`;
  }
  return v;
}

function serializeUrlValue(v: unknown): unknown {
  return v instanceof URL ? v.href : v;
}

function serializeDateValue(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}

function serializeRequestValue(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  const r = v as Record<string, unknown>;
  if (!('method' in r) && !('url' in r)) return v;
  return { method: r.method, url: r.url, headers: r.headers };
}

function serializeResponseValue(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  const r = v as Record<string, unknown>;
  if (!('status' in r) && !('statusCode' in r)) return v;
  return { status: r.status ?? r.statusCode, headers: r.headers };
}

/**
 * A preset of common {@link Serializer}s keyed by the property names they match
 * (`error`, `date`, `buffer`, `url`, `req`, `res`). Spread it into your own
 * serializer map to get safe, compact representations of these types out of the
 * box, e.g. `createSerializeProcessor({ ...createDefaultSerializers(), user })`.
 *
 * Matching is by property name at any depth (see {@link createSerializeProcessor}),
 * so any object with a `req`/`res`/`url`/`error` property is normalized.
 */
export function createDefaultSerializers(): Record<string, Serializer> {
  return {
    error: serializeErrorValue,
    date: serializeDateValue,
    buffer: serializeBufferValue,
    url: serializeUrlValue,
    req: serializeRequestValue,
    res: serializeResponseValue,
  };
}
