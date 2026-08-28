import { describe, it, expect } from 'vitest';
import { isElectronProcess, getElectron } from '../src/runtime/electron-binding.js';
import {
  isElectronProcess as isBrowser,
  getElectron as getBrowser,
} from '../src/runtime/electron-binding.browser.js';

describe('electron-binding (real, non-electron env)', () => {
  it('isElectronProcess() is false outside electron', () => {
    expect(isElectronProcess()).toBe(false);
  });

  it('getElectron() throws and caches the failure (second call hits cache)', () => {
    expect(() => getElectron()).toThrow();
    // Second call hits the cached `null` branch instead of re-detecting.
    expect(() => getElectron()).toThrow();
  });
});

describe('electron-binding.browser (stub)', () => {
  it('reports not-an-electron-process', () => {
    expect(isBrowser()).toBe(false);
  });

  it('getElectron always throws', () => {
    expect(() => getBrowser()).toThrow();
  });
});
