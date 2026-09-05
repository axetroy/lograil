import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogEntry } from '../src/types.js';

// Hoisted: mock the shim so `open` rejects, forcing a write error on first
// write. With no onError hook, FileTransport falls back to console.error.
vi.mock('../src/shims/index.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    open: vi.fn().mockRejectedValue(new Error('ENOSPC: no space left on device')),
  };
});

import { FileTransport } from '../src/transport/file.js';

function entry(message: string): LogEntry {
  return {
    level: 30,
    levelName: 'info',
    message,
    args: [],
    timestamp: Date.now(),
    time: new Date().toISOString(),
    scope: undefined,
    pid: 1,
    context: {},
    metadata: {},
  };
}

describe('FileTransport - console.error fallback', () => {
  it('logs write errors to console.error when onError is unset', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'lograil-consolerr-'));
    try {
      const t = new FileTransport({ mode: 'single', appName: 'app', dir, ext: 'log' });
      // onError intentionally left unset.
      t.write(entry('boom'), 'boom');
      await t.flush();
      expect(consoleError).toHaveBeenCalled();
      expect(String(consoleError.mock.calls[0][0])).toContain(
        '[lograil] FileTransport write error:',
      );
      await t.close();
    } finally {
      consoleError.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
