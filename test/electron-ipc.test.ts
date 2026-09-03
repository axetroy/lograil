import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  encodeEntry,
  decodeEntry,
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
  beforeEach(() => {
    send.mockClear();
    on.mockClear();
    removeListener.mockClear();
  });

  it('sends the entry over ipcRenderer.send', () => {
    const t = new ElectronIpcTransport();
    t.write(entry(), '');
    expect(send).toHaveBeenCalledWith(LOGRAIL_CHANNEL, entry());
  });

  it('registerIpcReceiver wires ipcMain.on and unregister removes it', () => {
    const ingest = vi.fn();
    const unregister = registerIpcReceiver(ingest);
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

  it('uses postMessage with pre-serialized buffer when available', () => {
    const postMessage = vi.fn();
    const send = vi.fn();
    const t = new ElectronIpcTransport({ ipcRenderer: { send, postMessage } });
    const e = entry();
    t.write(e, '');
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [channel, message] = postMessage.mock.calls[0];
    expect(channel).toBe(LOGRAIL_CHANNEL);
    expect(message).toBeInstanceOf(ArrayBuffer);
    // The transferred buffer decodes back to the original entry.
    expect(decodeEntry(message as ArrayBuffer)).toMatchObject({
      levelName: 'info',
      message: 'hi',
    });
    // The legacy structured-clone `send` path is not used.
    expect(send).not.toHaveBeenCalled();
  });

  it('receiver decodes a transferred buffer and marks it renderer-origin', () => {
    const ingest = vi.fn();
    registerIpcReceiver(ingest);
    const handler = on.mock.calls[on.mock.calls.length - 1][1] as (
      event: unknown,
      payload: unknown,
    ) => void;
    handler({}, encodeEntry(entry()));
    expect(ingest).toHaveBeenCalledTimes(1);
    const received = ingest.mock.calls[0][0] as LogEntry;
    expect(received.message).toBe('hi');
    expect(received.metadata[RENDERER_PROCESS_MARKER]).toBe('renderer');
  });

  it('receiver routes level commands to onLevelCommand callback', () => {
    const ingest = vi.fn();
    const onLevelCommand = vi.fn();
    registerIpcReceiver(ingest, { onLevelCommand });
    const handler = on.mock.calls[on.mock.calls.length - 1][1] as (
      event: unknown,
      payload: unknown,
    ) => void;

    // Send a level command
    const cmd = JSON.stringify({ __lograilCmd: true, __lograilCmdType: 'setLevel', level: 20 });
    handler({}, new TextEncoder().encode(cmd));

    expect(onLevelCommand).toHaveBeenCalledTimes(1);
    expect(onLevelCommand).toHaveBeenCalledWith(20);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('transport sends level commands via sendLevelCommand', () => {
    const postMessage = vi.fn();
    const send = vi.fn();
    const t = new ElectronIpcTransport({ ipcRenderer: { send, postMessage } });
    t.sendLevelCommand(20);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [channel, message] = postMessage.mock.calls[0];
    expect(channel).toBe(LOGRAIL_CHANNEL);
    expect(message).toBeInstanceOf(ArrayBuffer);
  });
});
