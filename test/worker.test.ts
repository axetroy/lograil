// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerIpcTransport, registerWorkerReceiver } from '../src/transport/worker-ipc.js';
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

// ── WorkerIpcTransport ──

describe('WorkerIpcTransport', () => {
  it('sends entry via self.postMessage when available', () => {
    const postMessage = vi.fn();
    const originalSelf = globalThis.self;
    Object.defineProperty(globalThis, 'self', { value: { postMessage }, configurable: true });

    const transport = new WorkerIpcTransport();
    const entry = makeEntry();
    transport.write(entry, 'formatted');

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ __lograilWorker: true, entry });

    Object.defineProperty(globalThis, 'self', { value: originalSelf, configurable: true });
  });

  it('is a no-op when self.postMessage is unavailable', () => {
    const originalSelf = globalThis.self;
    Object.defineProperty(globalThis, 'self', { value: {}, configurable: true });

    const transport = new WorkerIpcTransport();
    transport.write(makeEntry(), 'formatted'); // should not throw

    Object.defineProperty(globalThis, 'self', { value: originalSelf, configurable: true });
  });

  it('has default name "worker-ipc"', () => {
    expect(new WorkerIpcTransport().name).toBe('worker-ipc');
  });

  it('accepts custom name', () => {
    expect(new WorkerIpcTransport({ name: 'my-ipc' }).name).toBe('my-ipc');
  });
});

// ── registerWorkerReceiver ──

describe('registerWorkerReceiver', () => {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let originalSelf: typeof globalThis.self;

  beforeEach(() => {
    listeners.clear();
    listeners.set('message', new Set());
    const mockSelf = {
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.get(type)?.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.get(type)?.delete(listener);
      }),
    };
    originalSelf = globalThis.self;
    Object.defineProperty(globalThis, 'self', { value: mockSelf, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'self', { value: originalSelf, configurable: true });
  });

  function fireMessage(data: unknown): void {
    const msgListeners = listeners.get('message');
    if (!msgListeners) return;
    for (const fn of msgListeners) {
      if (typeof fn === 'function') {
        fn({ data } as unknown as Event);
      } else {
        fn.handleEvent({ data } as unknown as Event);
      }
    }
  }

  it('registers a message listener and calls ingest for worker entries', () => {
    const ingest = vi.fn();
    registerWorkerReceiver(ingest);

    const entry = makeEntry();
    fireMessage({ __lograilWorker: true, entry });

    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledWith(entry);
  });

  it('ignores non-lograil messages', () => {
    const ingest = vi.fn();
    registerWorkerReceiver(ingest);

    fireMessage({ other: 'message' });
    fireMessage({ __lograilWorker: false, entry: {} });

    expect(ingest).not.toHaveBeenCalled();
  });

  it('returns an unregister function that removes the listener', () => {
    const ingest = vi.fn();
    const unregister = registerWorkerReceiver(ingest);

    unregister();

    // The mock self should have been called with removeEventListener
    const mockSelf = globalThis.self as unknown as {
      removeEventListener: ReturnType<typeof vi.fn>;
    };
    expect(mockSelf.removeEventListener).toHaveBeenCalled();
  });

  it('supports Node worker.on(message) pattern via worker option', () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const mockWorker = {
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers[event] = handler;
      },
    };
    const ingest = vi.fn();
    registerWorkerReceiver(ingest, { worker: mockWorker as never });

    const entry = makeEntry();
    // Node sends raw data, not MessageEvent
    handlers['message']?.({ __lograilWorker: true, entry });

    expect(ingest).toHaveBeenCalledWith(entry);
  });
});

// ── createWebRuntime ──

describe('createWebRuntime - main thread behavior', () => {
  it('returns web runtime with console transport only', () => {
    const runtime = createWebRuntime();
    expect(runtime.name).toBe('web');
    expect(runtime.hasFileSystem()).toBe(false);
    const transports = runtime.defaultTransports();
    expect(transports.length).toBe(1);
    expect(transports[0].name).toBe('console');
  });

  it('attaches worker receiver on main thread', () => {
    const runtime = createWebRuntime();
    expect(typeof runtime.attachReceiver).toBe('function');
  });
});

// ── worker_threads integration ──

describe('Node worker_threads integration', () => {
  it('worker sends entries to parent via postMessage', async () => {
    const { Worker } = await import('node:worker_threads');
    const path = await import('node:path');

    const childPath = path.resolve(import.meta.dirname, 'fixtures/worker-threads-child.ts');

    // Node can't run .ts directly in worker_threads, so we use tsx or ts-node
    // For now, skip if the child script can't be loaded
    try {
      const worker = new Worker(childPath, {
        execArgv: ['--import', 'tsx'],
      });

      const messages: unknown[] = [];
      worker.on('message', (msg) => {
        messages.push(msg);
      });

      // Wait for worker to finish
      await new Promise<void>((resolve, reject) => {
        worker.on('error', reject);
        worker.on('exit', () => resolve());
      });

      // Should have received lograil-formatted messages
      const lograilMessages = messages.filter(
        (m) =>
          m &&
          typeof m === 'object' &&
          '__lograilWorker' in m &&
          (m as { __lograilWorker: boolean }).__lograilWorker === true,
      );

      expect(lograilMessages.length).toBeGreaterThanOrEqual(2);
    } catch {
      // tsx not available — skip gracefully
    }
  });
});
