/**
 * Lightweight `printf`-style message formatting (a tiny subset of Node's
 * `util.format`), so callers can write `logger.info('user %s logged in', name)`
 * instead of the more allocation-heavy template literal
 * `logger.info(\`user ${name} logged in\`);`.
 *
 * Supported specifiers:
 *   %s  string
 *   %d  number (with %i alias for integer)
 *   %j  JSON
 *   %o  object (multi-line-ish preview via util-like toString)
 *   %O  object (same as %o here)
 *   %%  literal '%'
 *
 * Design notes (performance):
 * - The caller only invokes {@link formatMessage} when a message is a string
 *   AND at least one argument is present AND a *legal* specifier exists. This
 *   keeps the common `~string + object~` case (the dominant structured-logging
 *   pattern) on the zero-format fast path.
 * - `%o`/`%O` use a short inline preview rather than pulling in `util`, keeping
 *   the module dependency-free (works in browsers/Electron renderers too).
 */

const SPECIFIER = /%[%sdjifoO]/;

/** True when `msg` contains at least one legal `printf` specifier. */
export function hasPrintfSpecifier(msg: string): boolean {
  return SPECIFIER.test(msg);
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'function') {
    return `[Function: ${(v as { name?: string }).name || 'anonymous'}]`;
  }
  try {
    if (typeof v === 'object') {
      if (Array.isArray(v)) return `[${v.map(stringify).join(', ')}]`;
      const ctor = (v as { constructor?: { name?: string } }).constructor?.name;
      const name = ctor && ctor !== 'Object' ? `${ctor} ` : '';
      const keys = Object.keys(v as Record<string, unknown>);
      const preview = keys
        .slice(0, 8)
        .map((k) => `${k}: ${stringify((v as Record<string, unknown>)[k])}`)
        .join(', ');
      const more = keys.length > 8 ? ` …+${keys.length - 8}` : '';
      return `${name}{${preview}${more}}`;
    }
    return String(v);
  } catch {
    return String(v);
  }
}

function asJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Format `message` with `args` using `printf`-style specifiers.
 *
 * @returns a tuple `[formattedMessage, ...remainingArgs]` where
 *   `remainingArgs` are the positional args that were NOT consumed by a
 *   specifier (mirroring `util.format`'s trailing-args behaviour, so the rest
 *   of the pipeline still receives structured data).
 */
export function formatMessage(message: string, args: unknown[]): [string, ...unknown[]] {
  const out: string[] = [];
  let argIdx = 0;
  let i = 0;
  const n = message.length;
  while (i < n) {
    const ch = message[i];
    if (ch === '%' && i + 1 < n) {
      const next = message[i + 1];
      switch (next) {
        case '%':
          out.push('%');
          i += 2;
          continue;
        case 's':
          out.push(stringify(args[argIdx]));
          argIdx++;
          i += 2;
          continue;
        case 'd':
        case 'i':
          out.push(
            typeof args[argIdx] === 'number' || typeof args[argIdx] === 'bigint'
              ? String(args[argIdx])
              : String(Number(args[argIdx])),
          );
          argIdx++;
          i += 2;
          continue;
        case 'j':
          out.push(asJson(args[argIdx]));
          argIdx++;
          i += 2;
          continue;
        case 'o':
        case 'O':
          out.push(stringify(args[argIdx]));
          argIdx++;
          i += 2;
          continue;
        default:
          // Not a specifier we handle — emit literally and advance by one so
          // we don't swallow the following char.
          out.push('%');
          i += 1;
          continue;
      }
    }
    out.push(ch);
    i += 1;
  }
  const rest = args.slice(argIdx);
  return [out.join(''), ...rest];
}
