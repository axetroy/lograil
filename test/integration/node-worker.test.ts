import { describe, it, expect, vi } from 'vitest';
import { isMainThread, parentPort } from 'node:worker_threads';
import {
  ClusterIpcTransport,
  createNodeRuntime,
  registerClusterReceiver,
  registerWorkerReceiver,
  _resetClusterReceiverState,
  _resetWorkerReceiverState,
} from '../../src/index.js';
import type { LogEntry } from '../../src/types.js';

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 30,
    levelName: 'info',
    message: 'hello',
    args: [],
    timestamp: 1_700_000_000_000,
    time: new Date(1_700_000_000_000).toISOString(),
    context: {},
    metadata: {},
    ...over,
  };
}

describe('integration: Node runtime — cluster & worker_threads', () => {
  it('createNodeRuntime returns primary-path when neither cluster nor worker_threads active', () => {
    const rt = createNodeRuntime({ appName: 'test-app' });
    expect(rt.name).toBe('node');
    expect(rt.hasFileSystem()).toBe(true);
    expect(rt.pid()).toBe(process.pid);
  });

  it('ClusterIpcTransport.write sends to process.send with callback', () => {
    const entries: unknown[] = [];
    const mockSend = vi.fn((msg: unknown, cb?: (err?: Error) => void) => {
      entries.push(msg);
      if (typeof cb === 'function') cb();
      return true;
    });
    const origSend = process.send;
    (process as { send?: unknown }).send = mockSend;

    const transport = new ClusterIpcTransport();
    const entry = makeEntry({ message: 'cluster hello' });
    transport.write(entry, 'formatted');

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sent = entries[0] as Record<string, unknown>;
    expect(sent.level).toBe(30);
    expect(sent.message).toBe('cluster hello');

    transport.sendLevelCommand(40);
    expect(mockSend).toHaveBeenCalledTimes(2);
    const cmd = entries[1] as Record<string, unknown>;
    expect(cmd.__lograilCmd).toBe(true);
    expect(cmd.__lograilCmdType).toBe('setLevel');
    expect(cmd.level).toBe(40);

    (process as { send?: unknown }).send = origSend;
  });

  it('registerClusterReceiver with mock process.on drops non-entry messages', () => {
    _resetClusterReceiverState();
    const ingest = vi.fn();
    const mockOn = vi.fn((_event: string, cb: (msg: unknown) => void) => {
      cb('not an entry');
    });
    const mockRemoveListener = vi.fn();
    const origOn = process.on;
    const origRemove = process.removeListener;
    (process as { on?: unknown }).on = mockOn;
    (process as { removeListener?: unknown }).removeListener = mockRemoveListener;

    registerClusterReceiver(ingest);

    expect(ingest).not.toHaveBeenCalled();
    expect(mockOn).toHaveBeenCalled();

    (process as { on?: unknown }).on = origOn;
    (process as { removeListener?: unknown }).removeListener = origRemove;
  });

  it('registerWorkerReceiver with mock worker.on drops non-lograil messages', () => {
    _resetWorkerReceiverState();
    const ingest = vi.fn();
    const mockWorker = {
      on: vi.fn((_event: string, handler: (data: unknown) => void) => {
        handler('not a lograil message');
      }),
      postMessage: vi.fn(),
    };

    const unregister = registerWorkerReceiver(ingest, { worker: mockWorker });

    expect(ingest).not.toHaveBeenCalled();
    unregister();
  });

  it('worker_threads module reports main thread in test process', () => {
    expect(isMainThread).toBe(true);
    expect(parentPort).toBeNull();
  });
});
