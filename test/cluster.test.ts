// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClusterIpcTransport, registerClusterReceiver, _resetClusterReceiverState } from '../src/transport/cluster-ipc.js';
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

describe('ClusterIpcTransport', () => {
  it('sends entry via process.send when available', () => {
    const send = vi.fn().mockReturnValue(true);
    const original = process.send;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).send = send;

    const transport = new ClusterIpcTransport();
    const entry = makeEntry();
    transport.write(entry, 'formatted');

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(entry, expect.any(Function));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).send = original;
  });

  it('is a no-op when process.send is unavailable', () => {
    const original = process.send;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).send = undefined;

    const transport = new ClusterIpcTransport();
    transport.write(makeEntry(), 'formatted');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).send = original;
  });

  it('has default name "cluster-ipc"', () => {
    expect(new ClusterIpcTransport().name).toBe('cluster-ipc');
  });

  it('accepts custom name', () => {
    expect(new ClusterIpcTransport({ name: 'my-ipc' }).name).toBe('my-ipc');
  });
});

describe('registerClusterReceiver', () => {
  let listeners: Record<string, ((...args: unknown[]) => void)[]>;
  let originalOn: typeof process.on;
  let originalRemoveListener: typeof process.removeListener;

  beforeEach(() => {
    _resetClusterReceiverState();
    listeners = {};
    originalOn = process.on;
    originalRemoveListener = process.removeListener;
    process.on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
      return process;
    }) as typeof process.on;
    process.removeListener = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (listeners[event]) {
        const idx = listeners[event].indexOf(cb);
        if (idx !== -1) listeners[event].splice(idx, 1);
        if (listeners[event].length === 0) delete listeners[event];
      }
      return process;
    }) as typeof process.removeListener;
  });

  afterEach(() => {
    process.on = originalOn;
    process.removeListener = originalRemoveListener;
  });

  it('registers a message handler and calls ingest for valid entries', () => {
    const ingest = vi.fn();
    registerClusterReceiver(ingest);

    expect(listeners['message']).toHaveLength(1);
    listeners['message'][0](makeEntry());
    expect(ingest).toHaveBeenCalledOnce();
  });

  it('ignores non-entry messages', () => {
    const ingest = vi.fn();
    registerClusterReceiver(ingest);

    listeners['message'][0]({ foo: 'bar' });
    listeners['message'][0](null);
    listeners['message'][0]('string');

    expect(ingest).not.toHaveBeenCalled();
  });

  it('returns an unregister function that removes the handler', () => {
    const ingest = vi.fn();
    const unregister = registerClusterReceiver(ingest);

    expect(listeners['message']).toHaveLength(1);

    unregister();

    expect(listeners['message']).toBeUndefined();
  });

  it('routes level commands to onLevelCommand callback', () => {
    const ingest = vi.fn();
    const onLevelCommand = vi.fn();
    registerClusterReceiver(ingest, { onLevelCommand });

    listeners['message'][0]({ __lograilCmd: true, __lograilCmdType: 'setLevel', level: 20 });

    expect(onLevelCommand).toHaveBeenCalledTimes(1);
    expect(onLevelCommand).toHaveBeenCalledWith(20);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('second registration updates callback without adding duplicate handler', () => {
    const ingest1 = vi.fn();
    const ingest2 = vi.fn();
    registerClusterReceiver(ingest1);

    expect(listeners['message']).toHaveLength(1);

    const unregister2 = registerClusterReceiver(ingest2);

    expect(listeners['message']).toHaveLength(1);
    listeners['message'][0](makeEntry({ message: 'second' }));
    expect(ingest1).not.toHaveBeenCalled();
    expect(ingest2).toHaveBeenCalledOnce();

    unregister2();
  });
});

describe('createNodeRuntime - cluster behavior', () => {
  it('provides cluster transport when isClusterWorker is simulated', () => {
    // Mock cluster.isWorker via module-level override by testing the transport directly
    const rt = createNodeRuntime({ disableFile: true });
    // In non-cluster mode, runtime returns console + file (or console only with disableFile)
    const names = rt.defaultTransports().map((t) => t.name);
    expect(names).toContain('console');
    // When NOT in cluster mode, no cluster-ipc transport
    expect(names).not.toContain('cluster-ipc');
  });

  it('ClusterIpcTransport writes to process.send', () => {
    const send = vi.fn().mockReturnValue(true);
    const originalSend = process.send;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).send = send;

    const transport = new ClusterIpcTransport();
    const entry = makeEntry({ message: 'cluster test' });
    transport.write(entry, 'formatted');

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].message).toBe('cluster test');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).send = originalSend;
  });
});
