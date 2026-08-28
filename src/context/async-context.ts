import { AsyncLocalStorage } from 'node:async_hooks';

export type AmbientContext = Record<string, unknown>;

/**
 * Ambient (request-scoped) context propagation.
 *
 * Built on `AsyncLocalStorage`, so a context set with {@link runWithContext}
 * is automatically visible to **every** log call inside `fn` — including those
 * reached after `await` — without manual plumbing. In non-Node runtimes this
 * module is swapped for `async-context.browser.js` (via `package.json` `browser`)
 * which is a no-op, so the API is safe to call everywhere.
 */
export const asyncContext = {
  run<T>(fn: () => T, context: AmbientContext): T {
    return storage.run(context, fn);
  },
  runAsync<T>(fn: () => Promise<T>, context: AmbientContext): Promise<T> {
    return storage.run(context, fn);
  },
  get(): AmbientContext {
    return storage.getStore() ?? {};
  },
  supported(): boolean {
    return true;
  },
};

const storage = new AsyncLocalStorage<AmbientContext>();

/** Run `fn` with `context` active as the ambient logging context. */
export function runWithContext<T>(fn: () => T, context: AmbientContext): T {
  return asyncContext.run(fn, context);
}
