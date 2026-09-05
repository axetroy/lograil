import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Each test needs a fresh module instance so the module-level `cached`
// variable starts as `undefined`. We reset the module registry and dynamic-
// import the binding module inside the test body.
async function freshBinding() {
  vi.resetModules();
  return import('../src/runtime/electron-binding.js');
}

describe('electron-binding stub fallback (electron process, module absent)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns a minimal stub when require("electron") throws inside an electron process', async () => {
    // Pretend we run inside an Electron process...
    vi.stubGlobal('process', {
      ...process,
      versions: { ...process.versions, electron: '30.0.0' },
    });

    // ...but `require('electron')` fails (e.g. ELECTRON_SKIP_BINARY_DOWNLOAD=1).
    const mockRequire = vi.fn((id: string) => {
      if (id === 'electron') throw new Error('Cannot find module "electron"');
      throw new Error(`unexpected require: ${id}`);
    });
    (globalThis as Record<string, unknown>).require = mockRequire;

    const binding = await freshBinding();
    const got = binding.getElectron();
    expect(got).toBeDefined();
    expect(got.ipcRenderer).toBeDefined();
    expect(got.ipcMain).toBeDefined();
    expect(got.app).toBeDefined();
    // The stub app reports a fixed path.
    expect((got.app as unknown as { getPath: () => string }).getPath()).toBe('/tmp');
  });

  it('getElectronApp() returns undefined when not in an electron process', async () => {
    const binding = await freshBinding();
    expect(binding.getElectronApp()).toBeUndefined();
  });

  it('isElectronProcess() reflects the versions.electron flag', async () => {
    vi.stubGlobal('process', {
      ...process,
      versions: { ...process.versions, electron: '30.0.0' },
    });
    const binding = await freshBinding();
    expect(binding.isElectronProcess()).toBe(true);
  });
});
