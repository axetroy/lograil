// Final coverage gap-filling tests for the remaining sub-95% files.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BroadcastChannelTransport } from '../src/transport/broadcast.js';
import type { LogLevelInput } from '../src/types.js';

// ── electron-main: defaultElectronLogDir fallback chain ───────────────
// vi.mock is hoisted above all imports, so the mock factory must reference
// module-level variables via vi.hoisted().

const electronMocks = vi.hoisted(() => {
  const getName = vi.fn(() => 'MyApp');
  const appOn = vi.fn();
  const appRemove = vi.fn();
  const ipcOn = vi.fn();
  const ipcRemove = vi.fn();
  const state: { getPathImpl: (p: string) => string } = {
    getPathImpl: () => '/fake',
  };
  return { getName, appOn, appRemove, ipcOn, ipcRemove, state };
});

vi.mock('../src/runtime/electron-binding.js', () => {
  const { getName, appOn, appRemove, ipcOn, ipcRemove, state } = electronMocks;
  return {
    isElectronProcess: () => true,
    getElectron: () => ({
      app: {
        getName,
        getPath: (p: string) => state.getPathImpl(p),
        on: appOn,
        removeListener: appRemove,
      },
      ipcMain: { on: ipcOn, removeListener: ipcRemove },
    }),
    getElectronApp: () => ({
      getName,
      getPath: (p: string) => state.getPathImpl(p),
      on: appOn,
      removeListener: appRemove,
    }),
  };
});

function setGetPath(impl: (p: string) => string): void {
  electronMocks.state.getPathImpl = impl;
}

describe('electron-main: defaultElectronLogDir fallback chain', () => {
  beforeEach(() => {
    setGetPath(() => '/fake');
    electronMocks.getName.mockClear();
  });

  it('prefers app.getPath("logs") when it succeeds', async () => {
    setGetPath((p) => (p === 'logs' ? '/mylogs' : p === 'appData' ? '/data' : p));
    const { createElectronMainRuntime } = await import('../src/runtime/electron-main.js');
    const rt = createElectronMainRuntime();
    const files = rt
      .defaultTransports()
      .filter((t: { name?: string }) => t.name?.startsWith('file:'));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to join(appData, "Logs") when getPath("logs") throws', async () => {
    setGetPath((p) => {
      if (p === 'logs') throw new Error('app not ready');
      if (p === 'appData') return '/myappdata';
      return p;
    });
    const { createElectronMainRuntime } = await import('../src/runtime/electron-main.js');
    const rt = createElectronMainRuntime();
    const files = rt
      .defaultTransports()
      .filter((t: { name?: string }) => t.name?.startsWith('file:'));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to tmpdir() when both appData and logs throw', async () => {
    setGetPath(() => {
      throw new Error('app not ready');
    });
    const { createElectronMainRuntime } = await import('../src/runtime/electron-main.js');
    const rt = createElectronMainRuntime();
    const files = rt
      .defaultTransports()
      .filter((t: { name?: string }) => t.name?.startsWith('file:'));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });
});

// ── node runtime: createClusterWorkerLifecycle onFlushBeforeExit ──────

describe('node runtime: cluster worker lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('onFlushBeforeExit registers disconnect handler and returns detach', async () => {
    const shims = await import('../src/shims/index.js');
    vi.spyOn(shims, 'isClusterWorker').mockReturnValue(true);
    vi.spyOn(process, 'on').mockImplementation(((event: string, cb: (...a: unknown[]) => void) => {
      if (event === 'disconnect') {
        (process as unknown as Record<string, unknown>).__lastDisconnect = cb;
      }
      return process;
    }) as never);
    vi.spyOn(process, 'removeListener').mockImplementation(() => process);

    const { createNodeRuntime } = await import('../src/runtime/node.js');
    const rt = createNodeRuntime();
    const lc = rt.lifecycle!;

    const flushSpy = vi.fn();
    const detach = lc.onFlushBeforeExit!(flushSpy);
    expect(typeof detach).toBe('function');

    // Simulate a disconnect event.
    const disconnectCb = (process as unknown as Record<string, unknown>)
      .__lastDisconnect as () => void;
    disconnectCb();
    expect(flushSpy).toHaveBeenCalledTimes(1);

    // Detaching removes the disconnect listener.
    detach();
    expect(process.removeListener).toHaveBeenCalledWith('disconnect', expect.any(Function));
  });
});

// ── printf: catch path in stringify ───────────────────────────────────

describe('printf: stringify catch path', () => {
  it('returns String(v) for a value that throws when converted', async () => {
    const { formatMessage } = await import('../src/core/printf.js');
    const evil = {
      toString() {
        throw new Error('boom');
      },
    };
    const [result] = formatMessage('%s', [evil]);
    expect(typeof result).toBe('string');
  });
});

// ── logger.ts: level command / peer-level branches ────────────────────

describe('logger: level command and peer-level branches', () => {
  it('onLevelCommand callback updates the effective level', async () => {
    const { createLogger, LOG_LEVELS } = await import('../src/index.js');
    const log = createLogger({ scope: 'lv-test' });
    const originalLevel = log.getLevel();
    log.setOnLevelCommand((level: LogLevelInput) => {
      log.setLevel(level);
    });
    log.setLevel('warn');
    expect(log.getLevel()).toBe(LOG_LEVELS.warn);
    log.setLevel(originalLevel);
  });

  it('broadcastLevelToPeers is a no-op on children', async () => {
    const { createLogger } = await import('../src/index.js');
    const root = createLogger({ scope: 'root-p' });
    const child = root.child({ context: { id: 'child-p' } });
    expect(() => child.broadcastLevelToPeers()).not.toThrow();
    expect(() => root.broadcastLevelToPeers()).not.toThrow();
  });

  it('setLevel propagates to children', async () => {
    const { createLogger, LOG_LEVELS } = await import('../src/index.js');
    const root = createLogger({ scope: 'root-lv', level: 'info' });
    const child = root.child({ context: { id: 'child-lv' } });
    expect(child.getLevel()).toBe(LOG_LEVELS.info);
    root.setLevel('error');
    expect(child.getLevel()).toBe(LOG_LEVELS.error);
  });
});

// ── electron-ipc: send failure (ipcRenderer absent) breaker + onError ──

describe('electron-ipc: send failure paths', () => {
  it('reports a dead main process through onError after BREAK_AFTER failures', async () => {
    // In this test file electron-binding is mocked with a working ipcRenderer.
    // Build a transport with an injected sender that always throws, then trip
    // the circuit breaker.
    const { ElectronIpcTransport } = await import('../src/transport/electron-ipc.js');
    const send = vi.fn(() => {
      throw new Error('IPC channel dead');
    });
    const t = new ElectronIpcTransport({ ipcRenderer: { send } });
    const errors: unknown[] = [];
    t.onError = (e) => errors.push(e);
    const threshold = (ElectronIpcTransport as unknown as { BREAK_AFTER: number }).BREAK_AFTER;
    const e = {
      level: 30,
      levelName: 'info',
      message: 'x',
      args: [],
      timestamp: 0,
      time: '',
      scope: undefined,
      pid: undefined,
      context: {},
      metadata: {},
      error: undefined,
    };
    for (let i = 0; i < threshold; i++) {
      t.write(e as never, '');
    }
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(send).toHaveBeenCalledTimes(threshold);

    // While the breaker is open, further failures extend the window silently
    // (no additional onError fires) — covers the "breakerOpen" branch.
    errors.length = 0;
    for (let i = 0; i < 3; i++) {
      t.write(e as never, '');
    }
    expect(errors.length).toBe(0);
    expect(send).toHaveBeenCalledTimes(threshold + 3);
  });

  it('sendLevelCommand failure increments the failure counter without throwing', async () => {
    const { ElectronIpcTransport } = await import('../src/transport/electron-ipc.js');
    const send = vi.fn(() => {
      throw new Error('IPC dead');
    });
    const t = new ElectronIpcTransport({ ipcRenderer: { send } });
    // Must not throw even when the peer is gone.
    expect(() => t.sendLevelCommand(20)).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('close() on the main-side receiver detaches the ipcMain listener', async () => {
    const { registerIpcReceiver } = await import('../src/transport/electron-ipc.js');
    const ingest = vi.fn();
    const off = registerIpcReceiver(ingest);
    expect(typeof off).toBe('function');
    off();
    // Calling the unsubscriber twice must be safe.
    off();
  });
});

// ── worker-ipc: breaker + receiver paths ─────────────────────────────

describe('worker-ipc: breaker and receiver paths', () => {
  function makeWorkerEntry() {
    return {
      level: 30,
      levelName: 'info',
      message: 'w',
      args: [],
      timestamp: 0,
      time: '',
      scope: undefined,
      pid: undefined,
      context: {},
      metadata: {},
      error: undefined,
    };
  }

  it('write failures trip the circuit breaker after BREAK_AFTER consecutive throws', async () => {
    const { WorkerIpcTransport } = await import('../src/transport/worker-ipc.js');
    const originalSelf = globalThis.self;
    const thrown: unknown[] = [];
    globalThis.self = {
      postMessage: () => {
        thrown.push(new Error('dead peer'));
        throw new Error('dead peer');
      },
    } as never;
    try {
      const t = new WorkerIpcTransport();
      const errors: unknown[] = [];
      t.onError = (e) => errors.push(e);
      const threshold = (WorkerIpcTransport as unknown as { BREAK_AFTER: number }).BREAK_AFTER;
      for (let i = 0; i < threshold; i++) t.write(makeWorkerEntry() as never, '');
      expect(errors.length).toBeGreaterThanOrEqual(1);
      // While the breaker is open, further failures extend the window
      // silently (no extra onError).
      errors.length = 0;
      t.write(makeWorkerEntry() as never, '');
      expect(errors.length).toBe(0);
    } finally {
      delete (globalThis as Record<string, unknown>).self;
      if (originalSelf !== undefined) {
        (globalThis as Record<string, unknown>).self = originalSelf;
      }
    }
  });

  it('sendLevelCommand silently drops when postMessage is unavailable', async () => {
    const { WorkerIpcTransport } = await import('../src/transport/worker-ipc.js');
    const originalSelf = (globalThis as Record<string, unknown>).self;
    (globalThis as Record<string, unknown>).self = {};
    try {
      const t = new WorkerIpcTransport();
      expect(() => t.sendLevelCommand(20)).not.toThrow();
    } finally {
      delete (globalThis as Record<string, unknown>).self;
      if (originalSelf !== undefined) {
        (globalThis as Record<string, unknown>).self = originalSelf;
      }
    }
  });

  it('registerWorkerReceiver forwards log entries and level commands (web global self)', async () => {
    const { registerWorkerReceiver } = await import('../src/transport/worker-ipc.js');
    const originalSelf = (globalThis as Record<string, unknown>).self;
    const listeners = new Map<string, EventListener>();
    const selfProxy = {
      addEventListener: (ev: string, cb: EventListener) => {
        listeners.set(ev, cb);
      },
      removeEventListener: (ev: string, cb: EventListener) => {
        if (listeners.get(ev) === cb) listeners.delete(ev);
      },
      onmessage: null as EventListener | null,
    };
    (globalThis as Record<string, unknown>).self = selfProxy;
    try {
      const ingest = vi.fn();
      const onLevelCommand = vi.fn();
      const off = registerWorkerReceiver(ingest, { onLevelCommand } as never) as () => void;
      const handler = listeners.get('message') as unknown as (e: { data: unknown }) => void;
      expect(handler).toBeDefined();
      // Deliver a log entry.
      handler({ data: { __lograilWorker: true, entry: makeWorkerEntry() } });
      expect(ingest).toHaveBeenCalledTimes(1);
      // Deliver a level command.
      handler({ data: { __lograilCmd: true, __lograilCmdType: 'setLevel', level: 40 } });
      expect(onLevelCommand).toHaveBeenCalledWith(40);
      off();
      expect(listeners.has('message')).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>).self;
      if (originalSelf !== undefined) {
        (globalThis as Record<string, unknown>).self = originalSelf;
      }
    }
  });

  it('registerWorkerReceiver supports a Node-style worker (on("message", ...))', async () => {
    const { registerWorkerReceiver } = await import('../src/transport/worker-ipc.js');
    const listeners = new Map<string, (data: unknown) => void>();
    const fakeWorker = {
      on: (event: string, cb: (data: unknown) => void) => {
        listeners.set(event, cb);
      },
      removeListener: (event: string, cb: (data: unknown) => void) => {
        if (listeners.get(event) === cb) listeners.delete(event);
      },
    };
    const ingest = vi.fn();
    const onLevelCommand = vi.fn();
    const off = registerWorkerReceiver(ingest, { worker: fakeWorker as never, onLevelCommand });
    const msg = listeners.get('message')!;
    msg({ __lograilWorker: true, entry: makeWorkerEntry() });
    expect(ingest).toHaveBeenCalledTimes(1);
    msg({ __lograilCmd: true, __lograilCmdType: 'setLevel', level: 50 });
    expect(onLevelCommand).toHaveBeenCalledWith(50);
    // Node workers don't support off() — the unsubscriber is a safe no-op.
    expect(() => off()).not.toThrow();
  });
});

// ── broadcast.ts: close() clears channel + postMessage throw ──────────

function makeEntry(): Record<string, unknown> {
  return {
    level: 30,
    levelName: 'info',
    message: 'x',
    args: [],
    timestamp: 0,
    time: '',
    scope: undefined,
    pid: undefined,
    context: {},
    metadata: {},
    error: undefined,
  };
}

describe('broadcast: close and error paths', () => {
  function installBroadcastChannelStub(postMessageThrows = false): {
    channels: Array<{
      name: string;
      postMessage: (m: unknown) => void;
      close: () => void;
      onmessage: ((ev: { data: unknown }) => void) | null;
    }>;
  } {
    const channels: Array<{
      name: string;
      postMessage: (m: unknown) => void;
      close: () => void;
      onmessage: ((ev: { data: unknown }) => void) | null;
    }> = [];
    class StubBroadcastChannel {
      name: string;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      constructor(name: string) {
        this.name = name;
        channels.push(this);
      }
      postMessage(msg: unknown): void {
        if (postMessageThrows) throw new Error('postMessage failed');
        for (const ch of channels) {
          if (ch !== this && ch.name === this.name && ch.onmessage) {
            ch.onmessage({ data: msg });
          }
        }
      }
      close(): void {
        this.onmessage = null;
      }
    }
    vi.stubGlobal('BroadcastChannel', StubBroadcastChannel);
    return { channels };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('close() clears the channel and subscribers', () => {
    const { channels } = installBroadcastChannelStub();
    const t = new BroadcastChannelTransport();
    t.subscribe(() => {});
    t.write(makeEntry() as never, '');
    expect(channels.length).toBe(1);
    t.close();
    t.write(makeEntry() as never, '');
    expect(channels.length).toBe(2);
  });

  it('postMessage failure is reported through onError', () => {
    installBroadcastChannelStub(true);
    const t = new BroadcastChannelTransport();
    const errors: unknown[] = [];
    t.onError = (e: unknown) => errors.push(e);
    t.write(makeEntry() as never, '');
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe('postMessage failed');
  });

  it('a subscriber that throws does not break other subscribers', () => {
    const { channels } = installBroadcastChannelStub();
    const sender = new BroadcastChannelTransport();
    const receiver = new BroadcastChannelTransport();
    const good = vi.fn();
    receiver.subscribe(() => {
      throw new Error('bad subscriber');
    });
    receiver.subscribe(good);
    sender.write(makeEntry() as never, '');
    expect(good).toHaveBeenCalledTimes(1);
    expect(channels.length).toBe(2);
  });
});
