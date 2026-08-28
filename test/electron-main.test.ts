import { describe, it, expect, vi, beforeEach } from 'vitest';

const getName = vi.fn(() => 'MyApp');
const getPath = vi.fn((p: string) => (p === 'appData' ? '/fake/appdata' : '/fake'));
const ipcOn = vi.fn();
const ipcRemove = vi.fn();

vi.mock('../src/runtime/electron-binding.js', () => ({
  isElectronProcess: () => true,
  getElectron: () => ({
    app: { getName, getPath },
    ipcMain: { on: ipcOn, removeListener: ipcRemove },
  }),
}));

import { createElectronMainRuntime } from '../src/runtime/electron-main.js';
import { ConsoleTransport } from '../src/transport/console.js';
import { RotatingFileTransport } from '../src/transport/rotating-file.js';

describe('createElectronMainRuntime', () => {
  beforeEach(() => {
    getName.mockClear();
    getPath.mockClear();
    ipcOn.mockClear();
    ipcRemove.mockClear();
  });

  it('reports electron/main metadata', () => {
    const rt = createElectronMainRuntime();
    expect(rt.name).toBe('electron');
    expect(rt.processType).toBe('main');
    expect(rt.hasFileSystem()).toBe(true);
  });

  it('defaults to console + rotating file transports', () => {
    const rt = createElectronMainRuntime({ appName: 'demo' });
    const ts = rt.defaultTransports();
    expect(ts.some((t) => t instanceof ConsoleTransport)).toBe(true);
    expect(ts.some((t) => t instanceof RotatingFileTransport)).toBe(true);
  });

  it('derives the default log path from app.getName / app.getPath', () => {
    const rt = createElectronMainRuntime();
    const ts = rt.defaultTransports();
    const file = ts.find((t) => t instanceof RotatingFileTransport) as RotatingFileTransport;
    expect(file.name).toContain('MyApp');
    expect(file.name).toContain('Lograil');
  });

  it('disableFile yields console only', () => {
    const rt = createElectronMainRuntime({ disableFile: true });
    const ts = rt.defaultTransports();
    expect(ts).toHaveLength(1);
    expect(ts[0]).toBeInstanceOf(ConsoleTransport);
  });

  it('receiveFromRenderer:false omits attachReceiver; default registers it', () => {
    const rtNo = createElectronMainRuntime({ receiveFromRenderer: false });
    expect(rtNo.attachReceiver).toBeUndefined();

    const rtYes = createElectronMainRuntime();
    expect(typeof rtYes.attachReceiver).toBe('function');
    const unreg = rtYes.attachReceiver!(() => {});
    expect(typeof unreg).toBe('function');
    expect(ipcOn).toHaveBeenCalled();
    unreg();
    expect(ipcRemove).toHaveBeenCalled();
  });

  it('falls back to process.argv when app.getName throws', () => {
    getName.mockImplementation(() => {
      throw new Error('no name');
    });
    const rt = createElectronMainRuntime();
    const ts = rt.defaultTransports();
    const file = ts.find((t) => t instanceof RotatingFileTransport) as RotatingFileTransport;
    expect(file).toBeDefined();
  });
});
