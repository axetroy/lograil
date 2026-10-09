// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WorkerIpcTransport,
  registerWorkerReceiver,
  _resetWorkerReceiverState,
} from '../src/transport/worker-ipc.js';
import { createNodeRuntime } from '../src/runtime/node.js';
import { createWebRuntime } from '../src/runtime/web.js';
import type { LogEntry } from '../src/types.js';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 30,
    levelName: 'info',
    message: 'test',
    args: [],
    timestamp: Date.now(),
    time: new Date().toISOString(),
    context: {},
    metadata: {},
    ...overrides,
  };
}

describe('WorkerIpcTransport', () => {
  it('sends entry via postMessage when available', () => {
    const postMessage = vi.fn();
    const mockSelf = { postMessage } as unknown as typeof self;
    const originalSelf = globalThis.self;
    Object.defineProperty(globalThis, 'self', { value: mockSelf, configurable: true });

    const transport = new WorkerIpcTransport();
    const entry = makeEntry();
    transport.write(entry, 'formatted');

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ __lograilWorker: true, entry });

    Object.defineProperty(globalThis, 'self', { value: originalSelf, configurable: true });
  });

  it('is a no-op when postMessage is unavailable', () => {
    const originalSelf = globalThis.self;
    Object.defineProperty(globalThis, 'self', { value: {}, configurable: true });

    const transport = new WorkerIpcTransport();
    transport.write(makeEntry(), 'formatted');

    Object.defineProperty(globalThis, 'self', { value: originalSelf, configurable: true });
  });

  it('has default name "worker-ipc"', () => {
    expect(new WorkerIpcTransport().name).toBe('worker-ipc');
  });
  it('accepts custom name', () => {
    expect(new WorkerIpcTransport({ name: 'my-ipc' }).name).toBe('my-ipc');
  });
});

describe('registerWorkerReceiver', () => {
  it('returns an unregister function when no self available', () => {
    _resetWorkerReceiverState();
    const ingest = vi.fn();
    const unregister = registerWorkerReceiver(ingest);
    expect(unregister).toBeDefined();
    expect(typeof unregister).toBe('function');
    unregister();
  });

  it('supports Node worker.on(message) pattern via worker option', () => {
    _resetWorkerReceiverState();
    const ingest = vi.fn();
    const workerHandlers: ((data: unknown) => void)[] = [];
    const worker = {
      on: vi.fn((event: string, cb: (data: unknown) => void) => {
        if (event === 'message') workerHandlers.push(cb);
      }),
      postMessage: vi.fn(),
    } as unknown as {
      on: ReturnType<typeof vi.fn>;
      postMessage: (message: unknown, transfer?: unknown[]) => void;
    };

    registerWorkerReceiver(ingest, { worker });

    expect(worker.on).toHaveBeenCalledWith('message', expect.any(Function));
    workerHandlers[0]({ __lograilWorker: true, entry: makeEntry() });
    expect(ingest).toHaveBeenCalledOnce();
  });

  it('restores a pre-existing worker.onmessage handler on cleanup (P2-13)', () => {
    // A page that already set `worker.onmessage` for its own IPC must not
    // have that handler silently clobbered — the unregister callback should
    // restore it, not null it out.
    _resetWorkerReceiverState();
    const ingest = vi.fn();
    const preExisting = vi.fn();
    const worker = {
      onmessage: preExisting as ((e: MessageEvent) => void) | null,
      postMessage: vi.fn(),
    };

    const unregister = registerWorkerReceiver(ingest, { worker });
    // While registered, our handler is in place.
    expect(worker.onmessage).not.toBe(preExisting);

    // Simulate one lograil message to confirm routing works.
    const entry = makeEntry();
    const ev = { data: { __lograilWorker: true, entry } } as unknown as MessageEvent;
    (worker.onmessage as (e: MessageEvent) => void)(ev);
    expect(ingest).toHaveBeenCalledOnce();

    // Cleanup must restore the pre-existing handler.
    unregister();
    expect(worker.onmessage).toBe(preExisting);
  });

  it('nulls worker.onmessage when no pre-existing handler was present', () => {
    _resetWorkerReceiverState();
    const ingest = vi.fn();
    const worker = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage: vi.fn(),
    };

    const unregister = registerWorkerReceiver(ingest, { worker });
    expect(worker.onmessage).not.toBeNull();

    unregister();
    expect(worker.onmessage).toBeNull();
  });

  it('routes Node worker level commands to onLevelCommand callback', () => {
    _resetWorkerReceiverState();
    const ingest = vi.fn();
    const onLevelCommand = vi.fn();
    const workerHandlers: ((data: unknown) => void)[] = [];
    const worker = {
      on: vi.fn((event: string, cb: (data: unknown) => void) => {
        if (event === 'message') workerHandlers.push(cb);
      }),
      postMessage: vi.fn(),
    } as unknown as {
      on: ReturnType<typeof vi.fn>;
      postMessage: (message: unknown, transfer?: unknown[]) => void;
    };

    registerWorkerReceiver(ingest, { worker, onLevelCommand });

    workerHandlers[0]({ __lograilCmd: true, __lograilCmdType: 'setLevel', level: 20 });

    expect(onLevelCommand).toHaveBeenCalledTimes(1);
    expect(onLevelCommand).toHaveBeenCalledWith(20);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('transport sends level commands via sendLevelCommand', () => {
    const postMessage = vi.fn();
    const mockSelfWithPost = { postMessage } as unknown as typeof self;
    const originalSelf = globalThis.self;
    Object.defineProperty(globalThis, 'self', { value: mockSelfWithPost, configurable: true });

    const transport = new WorkerIpcTransport();
    transport.sendLevelCommand(20);

    expect(postMessage).toHaveBeenCalledOnce();
    const sent = postMessage.mock.calls[0][0];
    expect(sent).toEqual({ __lograilCmd: true, __lograilCmdType: 'setLevel', level: 20 });

    Object.defineProperty(globalThis, 'self', { value: originalSelf, configurable: true });
  });
});

describe('registerWorkerReceiver — global self path', () => {
  let originalSelf: unknown;
  let messageHandlers: ((event: MessageEvent) => void)[];

  beforeEach(() => {
    _resetWorkerReceiverState();
    originalSelf = globalThis.self;
    messageHandlers = [];
    const mockSelf = {
      addEventListener: vi.fn((event: string, cb: EventListener) => {
        if (event === 'message') messageHandlers.push(cb as (event: MessageEvent) => void);
      }),
      removeEventListener: vi.fn((event: string, cb: EventListener) => {
        if (event === 'message') {
          const idx = messageHandlers.indexOf(cb as (event: MessageEvent) => void);
          if (idx !== -1) messageHandlers.splice(idx, 1);
        }
      }),
      onmessage: null as ((e: MessageEvent) => void) | null,
    };
    Object.defineProperty(globalThis, 'self', { value: mockSelf, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'self', { value: originalSelf, configurable: true });
  });

  it('both subscribers receive messages on global self path', () => {
    const ingest1 = vi.fn();
    const ingest2 = vi.fn();
    const unregister1 = registerWorkerReceiver(ingest1);
    const unregister2 = registerWorkerReceiver(ingest2);

    expect(messageHandlers).toHaveLength(1);
    messageHandlers[0]({
      data: { __lograilWorker: true, entry: makeEntry({ message: 'a' }) },
    } as unknown as MessageEvent);
    expect(ingest1).toHaveBeenCalledTimes(1);
    expect(ingest2).toHaveBeenCalledTimes(1);

    unregister1();
    messageHandlers[0]({
      data: { __lograilWorker: true, entry: makeEntry({ message: 'b' }) },
    } as unknown as MessageEvent);
    expect(ingest1).toHaveBeenCalledTimes(1);
    expect(ingest2).toHaveBeenCalledTimes(2);

    unregister2();
    expect(
      (globalThis.self as unknown as { addEventListener: ReturnType<typeof vi.fn> })
        .addEventListener,
    ).toHaveBeenCalledTimes(1);
    expect(
      (globalThis.self as unknown as { removeEventListener: ReturnType<typeof vi.fn> })
        .removeEventListener,
    ).toHaveBeenCalledTimes(1);
  });

  it('level commands are forwarded to all subscribers onLevelCommand', () => {
    const onLevelCommand1 = vi.fn();
    const onLevelCommand2 = vi.fn();
    registerWorkerReceiver(vi.fn(), { onLevelCommand: onLevelCommand1 });
    registerWorkerReceiver(vi.fn(), { onLevelCommand: onLevelCommand2 });

    messageHandlers[0]({
      data: { __lograilCmd: true, __lograilCmdType: 'setLevel', level: 20 },
    } as unknown as MessageEvent);
    expect(onLevelCommand1).toHaveBeenCalledWith(20);
    expect(onLevelCommand2).toHaveBeenCalledWith(20);
  });

  it('re-registration after last unsubscribe adds a new handler', () => {
    const unregister1 = registerWorkerReceiver(vi.fn());
    unregister1();
    expect(
      (globalThis.self as unknown as { removeEventListener: ReturnType<typeof vi.fn> })
        .removeEventListener,
    ).toHaveBeenCalledTimes(1);

    const unregister2 = registerWorkerReceiver(vi.fn());
    expect(messageHandlers).toHaveLength(1);
    unregister2();
  });
});

describe('createNodeRuntime - worker_threads behavior', () => {
  it('provides a WorkerIpcTransport in worker_threads mode', () => {
    const original = (globalThis as { parentPort?: unknown }).parentPort;
    Object.defineProperty(globalThis, 'parentPort', {
      value: { postMessage: vi.fn() },
      configurable: true,
    });

    const rt = createNodeRuntime({ disableFile: true });
    expect(rt.name).toBe('node');
    expect(rt.hasFileSystem()).toBe(false);
    const names = rt.defaultTransports().map((t) => t.name);
    expect(names).toContain('worker-ipc');

    if (original === undefined) {
      delete (globalThis as { parentPort?: unknown }).parentPort;
    } else {
      Object.defineProperty(globalThis, 'parentPort', { value: original, configurable: true });
    }
  });
});

describe('isWorkerThread detection (P1-7: multi-runtime worker detection)', () => {
  // The `isWorkerThread` helper is internal to `src/runtime/web.ts`, so we
  // verify its behavior through the public `createWebRuntime()` entry point.
  // Each test injects the minimal globals that a particular runtime exposes
  // and asserts whether the worker-ipc transport is present.
  const originals: Array<[PropertyKey, unknown]> = [];
  function inject(key: PropertyKey, value: unknown): void {
    originals.push([key, (globalThis as Record<PropertyKey, unknown>)[key]]);
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  function restore(): void {
    for (let i = originals.length - 1; i >= 0; i--) {
      const [key, orig] = originals[i];
      if (orig === undefined) delete (globalThis as Record<PropertyKey, unknown>)[key];
      else
        Object.defineProperty(globalThis, key, { value: orig, writable: true, configurable: true });
    }
    originals.length = 0;
  }

  function webRuntimeHasWorkerIpc(): boolean {
    const rt = createWebRuntime();
    return rt.defaultTransports().some((t: { name: string }) => t.name === 'worker-ipc');
  }

  afterEach(restore);

  it('detects a Deno worker via DedicatedWorkerGlobalScope', () => {
    inject('DedicatedWorkerGlobalScope', class {});
    // In a Deno worker, `self` is the worker global (no `document`).
    // We inject `self` as a plain object with no `document` so the check
    // `typeof self !== 'undefined'` passes, and the `document` check
    // returns `'undefined'`.
    inject('self', {});
    expect(webRuntimeHasWorkerIpc()).toBe(true);
  });

  it('detects a SharedWorker via SharedWorkerGlobalScope', () => {
    inject('SharedWorkerGlobalScope', class {});
    inject('self', {});
    expect(webRuntimeHasWorkerIpc()).toBe(true);
  });

  it('detects a Node worker via parentPort.postMessage', () => {
    inject('parentPort', { postMessage: vi.fn() });
    expect(webRuntimeHasWorkerIpc()).toBe(true);
  });

  it('does NOT detect a plain main thread', () => {
    // No worker globals, no parentPort → main thread, no worker-ipc.
    expect(webRuntimeHasWorkerIpc()).toBe(false);
  });
});
