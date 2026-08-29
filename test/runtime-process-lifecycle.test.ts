import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createProcessLifecycle } from '../src/runtime/process-lifecycle.js';

type OnSpy = {
  mock: { calls: Array<[string, (...args: unknown[]) => void]> };
};

/**
 * Unit tests for the process-backed lifecycle hooks. We exercise the real
 * `process` event surface (spying on `on` / `exit`) so we verify the hooks
 * register on the right events and translate them into the logger's flush
 * callback plus the correct exit code.
 */
describe('createProcessLifecycle', () => {
  beforeEach(() => {
    vi.spyOn(process, 'on');
    vi.spyOn(process, 'removeListener');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers beforeExit, SIGINT and SIGTERM in onFlushBeforeExit', () => {
    const lc = createProcessLifecycle();
    const detach = lc.onFlushBeforeExit(() => {});
    expect(process.on).toHaveBeenCalledWith('beforeExit', expect.any(Function));
    expect(process.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(process.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    // Detaching removes all three listeners.
    detach();
    expect(process.removeListener).toHaveBeenCalledWith('beforeExit', expect.any(Function));
    expect(process.removeListener).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(process.removeListener).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  it('invokes the flush callback on beforeExit', () => {
    const lc = createProcessLifecycle();
    const cb = vi.fn();
    lc.onFlushBeforeExit(cb);
    const onBeforeExit = (process.on as unknown as OnSpy).mock.calls.find(
      (c) => c[0] === 'beforeExit',
    )![1] as () => void;
    onBeforeExit();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('exits with 130 on SIGINT and 143 on SIGTERM after flushing', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const lc = createProcessLifecycle();
      const cb = vi.fn().mockResolvedValue(undefined);
      lc.onFlushBeforeExit(cb);
      const calls = (process.on as unknown as OnSpy).mock.calls;
      const sigint = calls.find((c) => c[0] === 'SIGINT')![1] as (code: number) => void;
      const sigterm = calls.find((c) => c[0] === 'SIGTERM')![1] as (code: number) => void;
      sigint(130);
      sigterm(143);
      await new Promise((r) => setTimeout(r, 10));
      expect(exit).toHaveBeenCalledWith(130);
      expect(exit).toHaveBeenCalledWith(143);
      expect(cb).toHaveBeenCalledTimes(2);
    } finally {
      exit.mockRestore();
    }
  });

  it('registers uncaughtException / unhandledRejection in onUncaughtError', () => {
    const lc = createProcessLifecycle();
    const detach = lc.onUncaughtError?.(() => {});
    expect(process.on).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(process.on).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    detach?.();
    expect(process.removeListener).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(process.removeListener).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
  });

  it('passes the error to the callback on uncaughtException and exits 1', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const lc = createProcessLifecycle();
      const cb = vi.fn().mockResolvedValue(undefined);
      lc.onUncaughtError?.(cb);
      const onErr = (process.on as unknown as OnSpy).mock.calls.find(
        (c) => c[0] === 'uncaughtException',
      )![1] as (err: unknown) => void;
      const err = new Error('boom');
      onErr(err);
      await new Promise((r) => setTimeout(r, 10));
      expect(cb).toHaveBeenCalledWith(err);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });

  it('invokes the callback with the reason on unhandledRejection', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const lc = createProcessLifecycle();
      const cb = vi.fn().mockResolvedValue(undefined);
      lc.onUncaughtError?.(cb);
      const onRej = (process.on as unknown as OnSpy).mock.calls.find(
        (c) => c[0] === 'unhandledRejection',
      )![1] as (reason: unknown) => void;
      const reason = new Error('rejected');
      onRej(reason);
      await new Promise((r) => setTimeout(r, 10));
      expect(cb).toHaveBeenCalledWith(reason);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });

  it('returns no-op hooks and detach when process is unavailable', () => {
    const original = (globalThis as { process?: unknown }).process;
    // Make `getProcess()` bail out: `process.on` is not a function.
    const savedOn = process.on;
    (process as { on?: unknown }).on = undefined;
    try {
      const lc = createProcessLifecycle();
      const detachFlush = lc.onFlushBeforeExit(() => {});
      const detachErr = lc.onUncaughtError?.(() => {});
      expect(detachFlush).toBeTypeOf('function');
      expect(detachErr).toBeTypeOf('function');
      // Detaching must not throw even though nothing was registered.
      expect(() => {
        detachFlush();
        detachErr?.();
      }).not.toThrow();
    } finally {
      (process as { on?: unknown }).on = savedOn;
      void original;
    }
  });
});
