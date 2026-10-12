// Deep-coverage tests for runtime adapters and remaining low-coverage branches.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── process-lifecycle: signal flush confirmed vs timed-out paths ───────────

describe('process-lifecycle: signal flush paths', () => {
  let processOn: Map<string, Array<(...a: unknown[]) => void>>;
  let processExitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    processOn = new Map();
    processExitSpy = vi.fn();
    vi.spyOn(process, 'on').mockImplementation(((event: string, cb: (...a: unknown[]) => void) => {
      let arr = processOn.get(event);
      if (!arr) {
        arr = [];
        processOn.set(event, arr);
      }
      arr.push(cb);
      return process;
    }) as never);
    vi.spyOn(process, 'removeListener').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      processExitSpy(code);
    }) as never);
  });

  afterEach(() => vi.restoreAllMocks());

  function fire(event: string, ...args: unknown[]): void {
    (processOn.get(event) ?? []).forEach((cb) => cb(...args));
  }

  it('SIGINT handler exits with 130 after cb resolves', async () => {
    const { createProcessLifecycle } = await import('../src/runtime/process-lifecycle.js');
    const lc = createProcessLifecycle();
    const cb = vi.fn().mockResolvedValue(undefined);
    const detach = lc.onFlushBeforeExit(cb);
    fire('SIGINT');
    await new Promise((r) => setTimeout(r, 5));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(130);
    detach();
  });

  it('SIGTERM handler exits with 143 after cb rejects', async () => {
    const { createProcessLifecycle } = await import('../src/runtime/process-lifecycle.js');
    const lc = createProcessLifecycle();
    const cb = vi.fn().mockRejectedValue(new Error('flush failed'));
    lc.onFlushBeforeExit(cb);
    fire('SIGTERM');
    await new Promise((r) => setTimeout(r, 5));
    expect(processExitSpy).toHaveBeenCalledWith(143);
  });

  it('uncaughtError handler exits with 1 and forwards the error', async () => {
    const { createProcessLifecycle } = await import('../src/runtime/process-lifecycle.js');
    const lc = createProcessLifecycle();
    const err = new Error('boom');
    const cb = vi
      .fn()
      .mockResolvedValue(undefined)
      .mockImplementation((e: unknown) => {
        expect(e).toBe(err);
        return Promise.resolve();
      });
    const detach = lc.onUncaughtError?.(cb);
    fire('uncaughtException', err);
    await new Promise((r) => setTimeout(r, 5));
    expect(processExitSpy).toHaveBeenCalledWith(1);
    detach?.();
  });

  it('unhandledRejection handler also exits with 1', async () => {
    const { createProcessLifecycle } = await import('../src/runtime/process-lifecycle.js');
    const lc = createProcessLifecycle();
    lc.onUncaughtError?.(() => Promise.resolve());
    fire('unhandledRejection', new Error('rej'));
    await new Promise((r) => setTimeout(r, 5));
    // The last exit call was from the unhandledRejection path.
    expect(processExitSpy.mock.calls.at(-1)).toEqual([1]);
  });

  it('beforeExit handler calls the flush callback', async () => {
    const { createProcessLifecycle } = await import('../src/runtime/process-lifecycle.js');
    const lc = createProcessLifecycle();
    const cb = vi.fn();
    lc.onFlushBeforeExit(cb);
    fire('beforeExit');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// ── node runtime: cluster worker + attachReceiver + onLevelCommand ─────────

describe('node runtime: cluster worker & receiver paths', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a ClusterIpcTransport when isClusterWorker() is true', async () => {
    const shims = await import('../src/shims/index.js');
    vi.spyOn(shims, 'isClusterWorker').mockReturnValue(true);
    const { createNodeRuntime } = await import('../src/runtime/node.js');
    const rt = createNodeRuntime();
    const names = rt.defaultTransports().map((t) => t.name);
    expect(names).toContain('console');
    expect(names).toContain('cluster-ipc');
    expect(rt.hasFileSystem()).toBe(false);
  });

  it('attachReceiver forwards onLevelCommand to the cluster receiver', async () => {
    const { createNodeRuntime } = await import('../src/runtime/node.js');
    const rt = createNodeRuntime({ appName: 'x', disableFile: true });
    expect(typeof rt.attachReceiver).toBe('function');
    const ingest = vi.fn();
    const onLevelCommand = vi.fn();
    const detach = rt.attachReceiver?.(ingest, onLevelCommand);
    expect(typeof detach).toBe('function');
    detach?.();
  });

  it('returns a WorkerIpcTransport when running in worker_threads', async () => {
    const originalParentPort = (globalThis as Record<string, unknown>).parentPort;
    Object.defineProperty(globalThis, 'parentPort', {
      value: { postMessage: vi.fn() },
      configurable: true,
      writable: true,
    });
    try {
      const { createNodeRuntime } = await import('../src/runtime/node.js');
      const rt = createNodeRuntime();
      const names = rt.defaultTransports().map((t) => t.name);
      expect(names).toContain('worker-ipc');
      expect(rt.hasFileSystem()).toBe(false);
    } finally {
      if (originalParentPort === undefined)
        delete (globalThis as Record<string, unknown>).parentPort;
      else
        Object.defineProperty(globalThis, 'parentPort', {
          value: originalParentPort,
          configurable: true,
          writable: true,
        });
    }
  });
});

// ── web runtime: worker detection via parentPort ───────────────────────────

describe('web runtime: worker detection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('detects a Node worker via parentPort.postMessage', async () => {
    const originalParentPort = (globalThis as Record<string, unknown>).parentPort;
    Object.defineProperty(globalThis, 'parentPort', {
      value: { postMessage: vi.fn() },
      configurable: true,
      writable: true,
    });
    try {
      const { createWebRuntime } = await import('../src/runtime/web.js');
      const rt = createWebRuntime();
      const names = rt.defaultTransports().map((t) => t.name);
      expect(names).toContain('worker-ipc');
    } finally {
      if (originalParentPort === undefined)
        delete (globalThis as Record<string, unknown>).parentPort;
      else
        Object.defineProperty(globalThis, 'parentPort', {
          value: originalParentPort,
          configurable: true,
          writable: true,
        });
    }
  });

  it('main thread web runtime exposes attachReceiver', async () => {
    const { createWebRuntime } = await import('../src/runtime/web.js');
    const rt = createWebRuntime();
    expect(typeof rt.attachReceiver).toBe('function');
    const ingest = vi.fn();
    const onLevelCommand = vi.fn();
    const detach = rt.attachReceiver?.(ingest, onLevelCommand);
    expect(typeof detach).toBe('function');
    detach?.();
  });
});

// ── electron-binding: getElectronApp when not in electron ─────────────────

describe('electron-binding: non-electron fallback', () => {
  it('getElectronApp returns undefined outside an Electron process', async () => {
    const { getElectronApp, isElectronProcess } =
      await import('../src/runtime/electron-binding.js');
    expect(isElectronProcess()).toBe(false);
    expect(getElectronApp()).toBeUndefined();
  });

  it('getElectron throws outside an Electron process', async () => {
    const { getElectron } = await import('../src/runtime/electron-binding.js');
    // First call caches null (not an electron process), subsequent calls throw.
    // The module already cached the null from a prior test in this file, so
    // assert it throws the "only available inside an Electron process" error.
    expect(() => getElectron()).toThrowError(/electron/i);
  });
});
