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
}));

import {
  ElectronIpcTransport,
  registerIpcReceiver,
  LOGRAIL_CHANNEL,
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
    t.write(entry());
    expect(send).toHaveBeenCalledWith(LOGRAIL_CHANNEL, entry());
  });

  it('registerIpcReceiver wires ipcMain.on and unregister removes it', () => {
    const ingest = vi.fn();
    const unregister = registerIpcReceiver(ingest);
    expect(on).toHaveBeenCalledWith(LOGRAIL_CHANNEL, expect.any(Function));
    const handler = on.mock.calls[0][1] as (event: unknown, entry: LogEntry) => void;
    handler({}, entry());
    expect(ingest).toHaveBeenCalledWith(entry());
    unregister();
    expect(removeListener).toHaveBeenCalledWith(LOGRAIL_CHANNEL, handler);
  });
});
