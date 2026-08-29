import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWebLifecycle } from '../src/runtime/web-lifecycle.js';

/**
 * Unit tests for the web (browser) lifecycle hooks. The hooks are driven by
 * `window` events (`pagehide` / `visibilitychange`), so we stub a minimal
 * `window` with the two listener methods and dispatch events to it.
 */
describe('createWebLifecycle', () => {
  let addEventListener: ReturnType<typeof vi.fn>;
  let removeEventListener: ReturnType<typeof vi.fn>;
  let handlers: Record<string, () => void>;

  beforeEach(() => {
    handlers = {};
    addEventListener = vi.fn((type: string, listener: () => void) => {
      handlers[type] = listener;
    });
    removeEventListener = vi.fn((type: string, listener: () => void) => {
      if (handlers[type] === listener) delete handlers[type];
    });
    vi.stubGlobal('window', { addEventListener, removeEventListener });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers pagehide and visibilitychange listeners', () => {
    const lc = createWebLifecycle();
    const detach = lc.onFlushBeforeExit(() => {});
    expect(addEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    detach();
    expect(removeEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('invokes the flush callback on pagehide', () => {
    const lc = createWebLifecycle();
    const cb = vi.fn();
    lc.onFlushBeforeExit(cb);
    handlers['pagehide']();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('invokes the flush callback on visibilitychange', () => {
    const lc = createWebLifecycle();
    const cb = vi.fn();
    lc.onFlushBeforeExit(cb);
    handlers['visibilitychange']();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('stops invoking the callback after detach', () => {
    const lc = createWebLifecycle();
    const cb = vi.fn();
    const detach = lc.onFlushBeforeExit(cb);
    detach();
    // Both listeners were removed, so firing them is a no-op.
    handlers['pagehide']?.();
    handlers['visibilitychange']?.();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('createWebLifecycle without a window', () => {
  it('returns a no-op detach and never touches window listeners', () => {
    // No `window` in the node environment → hooks are inert.
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal('window', undefined);
    void addEventListener;
    void removeEventListener;
    const lc = createWebLifecycle();
    const detach = lc.onFlushBeforeExit(() => {});
    expect(detach).toBeTypeOf('function');
    expect(() => detach()).not.toThrow();
  });
});
