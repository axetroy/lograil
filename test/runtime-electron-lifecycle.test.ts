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

  it('invokes the flush callback on app before-quit and will-quit', () => {
    const app = makeApp();
    (getElectronApp as ReturnType<typeof vi.fn>).mockReturnValue(app);
    const lc = createElectronLifecycle();
    const cb = vi.fn();
    lc.onFlushBeforeExit(cb);
    app.handlers['before-quit']();
    app.handlers['will-quit']();
    expect(cb).toHaveBeenCalledTimes(2);
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
