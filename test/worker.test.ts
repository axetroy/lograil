// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WorkerIpcTransport,
  registerWorkerReceiver,
  _resetWorkerReceiverState,
} from '../src/transport/worker-ipc.js';
import { createNodeRuntime } from '../src/runtime/node.js';
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
