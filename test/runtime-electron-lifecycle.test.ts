import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Isolate the electron binding so we control whether `app` is available without
// spinning up a real Electron process.
vi.mock('../src/runtime/electron-binding.js', () => ({
  isElectronProcess: () => true,
  getElectronApp: vi.fn(),
}));

import { createElectronLifecycle } from '../src/runtime/electron-lifecycle.js';
import { getElectronApp } from '../src/runtime/electron-binding.js';

function makeApp() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      handlers[event] = listener;
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (handlers[event] === listener) delete handlers[event];
    }),
    handlers,
  };
}

describe('createElectronLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'on');
    vi.spyOn(process, 'removeListener');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers app before-quit and will-quit listeners when app is available', () => {
    const app = makeApp();
    (getElectronApp as ReturnType<typeof vi.fn>).mockReturnValue(app);
    const lc = createElectronLifecycle();
    const detach = lc.onFlushBeforeExit(() => {});
    expect(app.on).toHaveBeenCalledWith('before-quit', expect.any(Function));
    expect(app.on).toHaveBeenCalledWith('will-quit', expect.any(Function));
    detach();
    expect(app.removeListener).toHaveBeenCalledWith('before-quit', expect.any(Function));
    expect(app.removeListener).toHaveBeenCalledWith('will-quit', expect.any(Function));
  });

  it('invokes the flush callback exactly once when both app events fire (P2-10)', () => {
    const app = makeApp();
    (getElectronApp as ReturnType<typeof vi.fn>).mockReturnValue(app);
    const lc = createElectronLifecycle();
    const cb = vi.fn();
    lc.onFlushBeforeExit(cb);
    app.handlers['before-quit']();
    app.handlers['will-quit']();
    // The `flushed` flag guarantees the callback runs at most once: the first
    // event (before-quit) does the work and the second (will-quit) is a no-op.
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('re-registers a fresh flush callback when the first registration is detached', () => {
    const app = makeApp();
    (getElectronApp as ReturnType<typeof vi.fn>).mockReturnValue(app);
    const lc = createElectronLifecycle();
    const cb1 = vi.fn();
    const detach1 = lc.onFlushBeforeExit(cb1);
    app.handlers['before-quit']();
    expect(cb1).toHaveBeenCalledTimes(1);
    detach1();

    // A second registration gets its own `flushed` flag and fires again.
    const cb2 = vi.fn();
    const detach2 = lc.onFlushBeforeExit(cb2);
    app.handlers['will-quit']();
    expect(cb2).toHaveBeenCalledTimes(1);
    detach2();
  });

  it('falls back to process hooks when app is unavailable', () => {
    (getElectronApp as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const onSpy = process.on;
    const lc = createElectronLifecycle();
    const detach = lc.onFlushBeforeExit(() => {});
    // No app listeners; instead the process-based hooks register.
    expect(onSpy).toHaveBeenCalledWith('beforeExit', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    detach();
    expect(process.removeListener).toHaveBeenCalledWith('beforeExit', expect.any(Function));
  });

  it('delegates uncaught-error handling to process hooks', () => {
    (getElectronApp as ReturnType<typeof vi.fn>).mockReturnValue(makeApp());
    const onSpy = process.on;
    const lc = createElectronLifecycle();
    const detach = lc.onUncaughtError?.(() => {});
    expect(onSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    detach?.();
    expect(process.removeListener).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
  });
});
