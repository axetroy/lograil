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
import { RENDERER_PROCESS_MARKER } from '../src/transport/electron-ipc.js';
import type { LogEntry } from '../src/types.js';

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
    const rt = createElectronMainRuntime();
    const ts = rt.defaultTransports();
    expect(ts.some((t) => t instanceof ConsoleTransport)).toBe(true);
    expect(ts.some((t) => t instanceof RotatingFileTransport)).toBe(true);
  });

  it('derives the default log path from app.getPath("appData")', () => {
    const rt = createElectronMainRuntime();
    const ts = rt.defaultTransports();
    const file = ts.find((t) => t instanceof RotatingFileTransport) as RotatingFileTransport;
    // Fixed `main.log` base under `<appData>/Lograil`, no appName involved.
    expect(getPath).toHaveBeenCalledWith('appData');
    expect(file.name).toContain('Lograil');
    expect(file.name).toContain('main.log');
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

  it('uses fixed main.log / renderer.log base names under <appData>/Lograil', () => {
    const rt = createElectronMainRuntime();
    const ts = rt.defaultTransports();
    const files = ts.filter((t): t is RotatingFileTransport => t instanceof RotatingFileTransport);
    expect(files[0].name).toContain('Lograil/main.log');
    expect(files[1].name).toContain('Lograil/renderer.log');
  });

  it('emits separate main + renderer log files when receiving from renderer', () => {
    const rt = createElectronMainRuntime();
    const ts = rt.defaultTransports();
    const files = ts.filter((t): t is RotatingFileTransport => t instanceof RotatingFileTransport);
    // main.log + renderer.log (formatted as main.{date}.{index}.log etc.)
    expect(files).toHaveLength(2);
    expect(files[0].name).toContain('main.log');
    expect(files[1].name).toContain('renderer.log');
  });

  it('renderer entries route to the renderer file and are excluded from main', () => {
    const rt = createElectronMainRuntime({ appName: 'demo' });
    const ts = rt.defaultTransports();
    const files = ts.filter((t): t is RotatingFileTransport => t instanceof RotatingFileTransport);
    const [mainFile, rendererFile] = files;
    const mainEntry: LogEntry = {
      level: 30,
      levelName: 'info',
      message: 'from main',
      args: [],
      timestamp: 1,
      time: '',
      context: undefined,
      metadata: {},
    };
    const rendererEntry: LogEntry = {
      ...mainEntry,
      message: 'from renderer',
      metadata: { [RENDERER_PROCESS_MARKER]: 'renderer' },
    };

    expect(mainFile.filter?.(mainEntry)).toBe(true);
    expect(mainFile.filter?.(rendererEntry)).toBe(false);
    expect(rendererFile.filter?.(mainEntry)).toBe(false);
    expect(rendererFile.filter?.(rendererEntry)).toBe(true);
  });

  it('disableFile still omits the renderer file', () => {
    const rt = createElectronMainRuntime({ disableFile: true });
    const ts = rt.defaultTransports();
    expect(ts.some((t) => t instanceof RotatingFileTransport)).toBe(false);
  });
});
