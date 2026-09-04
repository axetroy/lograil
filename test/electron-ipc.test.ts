import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const send = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();

vi.mock('../src/runtime/electron-binding.js', () => ({
  isElectronProcess: () => true,
  getElectron: () => ({
    ipcRenderer: { send },
    ipcMain: { on, removeListener },
  }),
  getElectronApp: () => ({ on: vi.fn(), removeListener: vi.fn() }),
}));

import {
  ElectronIpcTransport,
  registerIpcReceiver,
  LOGRAIL_CHANNEL,
  RENDERER_PROCESS_MARKER,
} from '../src/transport/electron-ipc.js';
import type { LogEntry } from '../src/types.js';
import { LOG_LEVELS } from '../src/types.js';

function entry(): LogEntry {
  return {
    level: LOG_LEVELS.info,
    levelName: 'info',
    message: 'hi',
    args: [],
    timestamp: 1,
    time: '',
    context: {},
    metadata: {},
  };
}

describe('ElectronIpcTransport (electron present)', () => {
  const unregisterFns: (() => void)[] = [];

  beforeEach(() => {
    send.mockClear();
    on.mockClear();
    removeListener.mockClear();
    // Clean up any leftover receivers from previous tests
    unregisterFns.forEach((fn) => fn());
    unregisterFns.length = 0;
  });

  afterEach(() => {
    // Ensure all receivers are unregistered after each test
    unregisterFns.forEach((fn) => fn());
    unregisterFns.length = 0;
  });

  function trackUnregister(fn: () => void): void {
    unregisterFns.push(fn);
  }

  it('sends the entry over ipcRenderer.send', () => {
    const t = new ElectronIpcTransport();
    t.write(entry(), '');
    expect(send).toHaveBeenCalledWith(LOGRAIL_CHANNEL, entry());
  });

  it('sends level commands over ipcRenderer.send', () => {
    const t = new ElectronIpcTransport();
    t.sendLevelCommand(20);
    expect(send).toHaveBeenCalledWith(LOGRAIL_CHANNEL, {
      __lograilCmd: true,
      __lograilCmdType: 'setLevel',
      level: 20,
    });
  });

  it('registerIpcReceiver wires ipcMain.on and unregister removes it', () => {
    const ingest = vi.fn();
    const unregister = registerIpcReceiver(ingest);
    trackUnregister(unregister);

    expect(on).toHaveBeenCalledWith(LOGRAIL_CHANNEL, expect.any(Function));
    const handler = on.mock.calls[0][1] as (event: unknown, entry: LogEntry) => void;
    const received = entry();
    handler({}, received);
    expect(ingest).toHaveBeenCalledTimes(1);
    // Renderer entries are marked so the main runtime can route them to a
    // dedicated renderer log file.
    expect(ingest.mock.calls[0][0].metadata[RENDERER_PROCESS_MARKER]).toBe('renderer');
    unregister();
    expect(removeListener).toHaveBeenCalledWith(LOGRAIL_CHANNEL, handler);
  });

  it('receiver marks entries as renderer-origin', () => {
    const ingest = vi.fn();
    const unregister = registerIpcReceiver(ingest);
    trackUnregister(unregister);

    const handler = on.mock.calls[on.mock.calls.length - 1][1] as (
      event: unknown,
      payload: unknown,
    ) => void;
    handler({}, entry());
    expect(ingest).toHaveBeenCalledTimes(1);
    const received = ingest.mock.calls[0][0] as LogEntry;
    expect(received.message).toBe('hi');
    expect(received.metadata[RENDERER_PROCESS_MARKER]).toBe('renderer');
  });

  it('receiver routes level commands to onLevelCommand callback', () => {
    const ingest = vi.fn();
    const onLevelCommand = vi.fn();
    const unregister = registerIpcReceiver(ingest, { onLevelCommand });
    trackUnregister(unregister);

    const handler = on.mock.calls[on.mock.calls.length - 1][1] as (
      event: unknown,
      payload: unknown,
    ) => void;

    const cmd = { __lograilCmd: true, __lograilCmdType: 'setLevel', level: 20 };
    handler({}, cmd);

    expect(onLevelCommand).toHaveBeenCalledTimes(1);
    expect(onLevelCommand).toHaveBeenCalledWith(20);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('both subscribers receive messages on the same channel', () => {
    const ingest1 = vi.fn();
    const ingest2 = vi.fn();

    const unregister1 = registerIpcReceiver(ingest1);
    trackUnregister(unregister1);
    expect(on).toHaveBeenCalledTimes(1);

    // Second registration reuses the same handler — does not add another
    const unregister2 = registerIpcReceiver(ingest2);
    trackUnregister(unregister2);
    expect(on).toHaveBeenCalledTimes(1);

    // Both subscribers should receive the message
    const handler = on.mock.calls[0][1] as (event: unknown, payload: unknown) => void;
    handler({}, entry());
    expect(ingest1).toHaveBeenCalledTimes(1);
    expect(ingest2).toHaveBeenCalledTimes(1);

    // Unregister first only — handler stays, second still receives
    unregister1();
    expect(removeListener).toHaveBeenCalledTimes(0);
    handler({}, entry());
    expect(ingest1).toHaveBeenCalledTimes(1);
    expect(ingest2).toHaveBeenCalledTimes(2);

    // Unregister second — now handler is removed
    unregister2();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('re-registration after last unsubscribe adds a new handler', () => {
    const ingest1 = vi.fn();
    const unregister1 = registerIpcReceiver(ingest1);
    unregister1();
    expect(removeListener).toHaveBeenCalledTimes(1);

    const ingest2 = vi.fn();
    const unregister2 = registerIpcReceiver(ingest2);
    trackUnregister(unregister2);
    expect(on).toHaveBeenCalledTimes(2);
  });
});
