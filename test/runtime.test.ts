import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createWebRuntime,
  createNodeRuntime,
  createElectronRuntime,
  createElectronMainRuntime,
  createElectronRendererRuntime,
  detectRuntime,
} from '../src/runtime/index.js';
import type { RuntimeAdapter } from '../src/runtime/index.js';
import type { Transport } from '../src/transport/transport.js';
import type { LogEntry } from '../src/types.js';

describe('Web runtime', () => {
  it('exposes web defaults with console transport only', () => {
    const rt = createWebRuntime();
    expect(rt.name).toBe('web');
    expect(rt.processType).toBeUndefined();
    expect(rt.pid()).toBeUndefined();
    expect(rt.hasFileSystem()).toBe(false);
    expect(rt.defaultTransports()).toHaveLength(1);
    expect(typeof rt.now()).toBe('number');
  });
});

describe('Node runtime', () => {
  it('exposes process id and filesystem', () => {
    const rt = createNodeRuntime();
    expect(rt.name).toBe('node');
    expect(rt.pid()).toBe(process.pid);
    expect(rt.hasFileSystem()).toBe(true);
    const names = rt.defaultTransports().map((t) => t.name);
    expect(names).toHaveLength(2);
    expect(names).toContain('console');
    expect(names.some((n) => n.startsWith('file:'))).toBe(true);
  });

  it('adds a file transport named after appName', () => {
    const rt = createNodeRuntime({ appName: 'myapp' });
    expect(rt.defaultTransports().map((t) => t.name)).toContain('file:myapp');
  });

  it('can disable the file transport', () => {
    const rt = createNodeRuntime({ appName: 'x', disableFile: true });
    expect(rt.defaultTransports()).toHaveLength(1);
  });
});

describe('Electron main runtime', () => {
  it('exposes pid, filesystem and a fixed main file transport', () => {
    const rt = createElectronMainRuntime();
    expect(rt.name).toBe('electron');
    expect(rt.processType).toBe('main');
    expect(rt.pid()).toBe(process.pid);
    expect(rt.hasFileSystem()).toBe(true);
    const names = rt.defaultTransports().map((t) => t.name);
    // Fixed path: <dir>/main.{date}.log (appName 'main').
    expect(names.some((n) => n.includes('file:main'))).toBe(true);
  });

  it('can disable the file transport explicitly', () => {
    const rt = createElectronMainRuntime({ disableFile: true });
    expect(rt.defaultTransports().map((t) => t.name)).toEqual(['console']);
  });

  it('exposes a receiver that is safe when electron is absent', () => {
    const rt = createElectronMainRuntime();
    expect(typeof rt.attachReceiver).toBe('function');
    // electron module is not installed in the test env; must not throw.
    const detach = rt.attachReceiver?.(() => {});
    expect(typeof detach).toBe('function');
    detach?.();
  });
});

describe('Electron renderer runtime', () => {
  it('forwards logs to the main process over IPC', () => {
    const rt = createElectronRendererRuntime();
    expect(rt.name).toBe('electron');
    expect(rt.processType).toBe('renderer');
    expect(rt.pid()).toBeUndefined();
    expect(rt.hasFileSystem()).toBe(false);
    expect(rt.defaultTransports().map((t) => t.name)).toEqual(['console', 'ipc:lograil:log']);
  });

  it('does not forward to main when forwardToMain is false', () => {
    const rt = createElectronRendererRuntime({ forwardToMain: false });
    expect(rt.defaultTransports().map((t) => t.name)).toEqual(['console']);
  });

  it('uses an injected ipcRenderer (no require needed) when provided', () => {
    const sent: Array<[string, unknown]> = [];
    const ipcRenderer = { send: (channel: string, data: unknown) => sent.push([channel, data]) };
    const rt = createElectronRendererRuntime({ ipcRenderer });
    const ipc = rt.defaultTransports().find((t) => t.name === 'ipc:lograil:log');
    expect(ipc).toBeDefined();
    const entry: LogEntry = {
      level: 4,
      levelName: 'info',
      message: 'x',
      args: [],
      timestamp: 1_700_000_000_000,
      time: '',
      context: {},
      metadata: {},
    };
    ipc!.write(entry, 'x');
    expect(sent).toEqual([['lograil:log', expect.objectContaining({ message: 'x' })]]);
  });
});

describe('Electron runtime (auto-detect)', () => {
  const originalType = (process as unknown as { type?: string }).type;

  afterEach(() => {
    (process as unknown as { type?: string }).type = originalType;
  });

  it('detects renderer when process.type is not browser', () => {
    (process as unknown as { type?: string }).type = 'renderer';
    const rt = createElectronRuntime();
    expect(rt.processType).toBe('renderer');
    expect(rt.defaultTransports().map((t) => t.name)).toEqual(['console', 'ipc:lograil:log']);
  });

  it('detects main when process.type is browser', () => {
    (process as unknown as { type?: string }).type = 'browser';
    const rt = createElectronRuntime();
    expect(rt.processType).toBe('main');
    const names = rt.defaultTransports().map((t) => t.name);
    expect(names.some((n) => n.includes('file:main'))).toBe(true);
  });

  it('treats an Electron process without an explicit renderer type as main', () => {
    (process as unknown as { type?: string }).type = undefined;
    const rt = createElectronRuntime();
    expect(rt.processType).toBe('main');
  });
});

describe('detectRuntime', () => {
  const originalVersions = process.versions;
  const originalType = (process as unknown as { type?: string }).type;

  afterEach(() => {
    Object.defineProperty(process, 'versions', {
      value: originalVersions,
      configurable: true,
    });
    (process as unknown as { type?: string }).type = originalType;
    vi.restoreAllMocks();
  });

  function stubVersions(versions: Record<string, string>): void {
    Object.defineProperty(process, 'versions', {
      value: versions,
      configurable: true,
    });
  }

  it('detects electron', () => {
    stubVersions({ electron: '28.0.0', node: '20.0.0' });
    expect(detectRuntime().name).toBe('electron');
  });

  it('detects plain node', () => {
    stubVersions({ node: '20.0.0' });
    expect(detectRuntime().name).toBe('node');
  });

  it('falls back to web when neither electron nor node is present', () => {
    stubVersions({});
    expect(detectRuntime().name).toBe('web');
  });

  it('uses a fixed main.log path on the detected electron main adapter', () => {
    stubVersions({ electron: '28.0.0', node: '20.0.0' });
    (process as unknown as { type?: string }).type = 'browser';
    const rt: RuntimeAdapter = detectRuntime();
    expect(rt.processType).toBe('main');
    const names = rt.defaultTransports().map((t: Transport) => t.name);
    expect(names.some((n) => n.includes('file:main'))).toBe(true);
  });
});
