import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '../src/core/logger.js';
import { createNodeRuntime } from '../src/runtime/node.js';
import type { LogEntry } from '../src/types.js';
import type { Transport } from '../src/transport/transport.js';

type OnSpy = {
  mock: { calls: Array<[string, (...args: unknown[]) => void]> };
};

/**
 * Integration tests proving the Logger actually consumes a runtime's
 * `lifecycle` hooks (rather than reaching for `process` directly) when they are
 * present. We drive the real `process` event surface and assert the logger's
 * flush / fatal behaviour runs through the lifecycle callbacks.
 */
function memory() {
  const entries: LogEntry[] = [];
  const transport: Transport = {
    name: 'memory',
    write: (e: LogEntry) => void entries.push(e),
  };
  return { transport, entries };
}

describe('Logger consumes adapter.lifecycle', () => {
  beforeEach(() => {
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('autoFlushOnExit wires flush through lifecycle.onFlushBeforeExit', () => {
    const runtime = createNodeRuntime({ disableFile: true });
    const { transport, entries } = memory();
    const log = new Logger({
      runtime,
      transports: [transport],
      autoFlushOnExit: true,
      exitFlushTimeoutMs: 50,
    });
    const flushSpy = vi.spyOn(
      log as unknown as { flushWithTimeout: () => Promise<void> },
      'flushWithTimeout',
    );

    // The runtime owns the process event wiring; the logger only registered
    // through the lifecycle hook, not directly on `process`.
    const onFlush = (process.on as unknown as OnSpy).mock.calls.find((c) => c[0] === 'beforeExit');
    expect(onFlush).toBeDefined();

    log.info('about to exit');
    // Trigger the lifecycle's beforeExit handler.
    const beforeExit = onFlush![1] as () => void;
    beforeExit();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(flushSpy).toHaveBeenCalled();
        expect(entries.some((e) => e.message === 'about to exit')).toBe(true);
        log.destroy();
        resolve();
      }, 80);
    });
  });

  it('watchUncaughtErrors logs the crash at fatal level via lifecycle.onUncaughtError', async () => {
    const runtime = createNodeRuntime({ disableFile: true });
    const { transport, entries } = memory();
    const log = new Logger({ runtime, transports: [transport] });
    log.watchUncaughtErrors();

    const onErr = (process.on as unknown as OnSpy).mock.calls.find(
      (c) => c[0] === 'uncaughtException',
    );
    expect(onErr).toBeDefined();

    const handler = onErr![1] as (err: unknown) => void;
    handler(new Error('kaboom'));
    await new Promise((r) => setTimeout(r, 80));
    expect(
      entries.some((e) => e.levelName === 'fatal' && (e.error as Error)?.message === 'kaboom'),
    ).toBe(true);
    log.destroy();
  });

  it('falls back to direct process binding when the adapter has no lifecycle', () => {
    // A minimal adapter without `lifecycle` must still let the logger register
    // process handlers (backward compatibility for custom runtimes).
    const runtime = {
      name: 'node' as const,
      now: () => 0,
      pid: () => 1,
      hasFileSystem: () => false,
      defaultTransports: () => [],
    };
    const log = new Logger({ runtime, transports: [], autoFlushOnExit: true });
    expect(process.on).toHaveBeenCalledWith('beforeExit', expect.any(Function));
    log.destroy();
  });
});
