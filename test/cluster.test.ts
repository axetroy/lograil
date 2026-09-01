// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClusterIpcTransport, registerClusterReceiver } from '../src/transport/cluster-ipc.js';
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
    // should not throw
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
        listeners[event] = listeners[event].filter((fn) => fn !== cb);
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

    // Simulate a valid cluster message
    const entry = makeEntry();
    listeners['message'][0](entry);

    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledWith(entry);
  });

  it('ignores non-entry messages', () => {
    const ingest = vi.fn();
    registerClusterReceiver(ingest);

    // Not a LogEntry — missing required fields
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

    expect(listeners['message']).toHaveLength(0);
  });

  it('routes level commands to onLevelCommand callback', () => {
    const ingest = vi.fn();
    const onLevelCommand = vi.fn();
    registerClusterReceiver(ingest, { onLevelCommand });

    // Send a level command
    listeners['message'][0]({ __lograilCmd: true, __lograilCmdType: 'setLevel', level: 20 });

    expect(onLevelCommand).toHaveBeenCalledTimes(1);
    expect(onLevelCommand).toHaveBeenCalledWith(20);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('transport sends level commands via sendLevelCommand', () => {
    const send = vi.fn().mockReturnValue(true);
    const original = process.send;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).send = send;

    const transport = new ClusterIpcTransport();
    transport.sendLevelCommand(20);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      __lograilCmd: true,
      __lograilCmdType: 'setLevel',
      level: 20,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).send = original;
  });
});

describe('createNodeRuntime - cluster behavior', () => {
  it('returns node runtime with file transport in non-cluster (primary)', () => {
    // In a normal vitest worker, cluster.isWorker is false
    const runtime = createNodeRuntime({ appName: 'test-app' });
    expect(runtime.name).toBe('node');
    expect(runtime.hasFileSystem()).toBe(true);
    const transports = runtime.defaultTransports();
    expect(transports.length).toBe(2); // ConsoleTransport + FileTransport
    expect(transports[1].name).toMatch(/^file/);
  });

  it('attaches cluster receiver on primary', () => {
    const runtime = createNodeRuntime({ appName: 'test-app' });
    expect(typeof runtime.attachReceiver).toBe('function');
  });
});
