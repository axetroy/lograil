import type { AmbientContext } from './async-context.js';

/**
 * Browser / non-Node stub. `AsyncLocalStorage` is unavailable here, so ambient
 * context is a no-op — logs are unaffected and no context propagates. The real
 * implementation (`async-context.ts`) is selected over this file in Node builds
 * via the `browser` field in `package.json`.
 */
// Shared frozen empty object returned when no async store is active, so the
// common (no ambient context) path allocates nothing on every `get()`.
const EMPTY_AMBIENT: AmbientContext = Object.freeze({});
export const asyncContext = {
  run<T>(fn: () => T, _context: AmbientContext): T {
    return fn();
  },
  runAsync<T>(fn: () => Promise<T>, _context: AmbientContext): Promise<T> {
    return fn();
  },
  get(): AmbientContext {
    return EMPTY_AMBIENT;
  },
  supported(): boolean {
    return false;
  },
};

/** Run `fn` with `context` active as the ambient logging context (no-op outside Node). */
export function runWithContext<T>(fn: () => T, _context: AmbientContext): T {
  return fn();
}
