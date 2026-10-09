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
      // `flush()` rejects when the write actually failed (the reported error is
      // re-thrown after the console.error fallback). We must catch it here.
      await t.flush().catch(() => {});
      expect(consoleError).toHaveBeenCalled();
      expect(String(consoleError.mock.calls[0][0])).toContain(
        '[lograil] FileTransport write error:',
      );
      await t.close().catch(() => {});
    } finally {
      consoleError.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flush() rejects when a write fails, so callers know the log was not persisted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lograil-flushreject-'));
    try {
      const t = new FileTransport({ mode: 'single', appName: 'app', dir, ext: 'log' });
      // No onError — the write error goes to console.error AND the promise
      // rejects, so flush() must surface the failure.
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      t.write(entry('boom'), 'boom');
      let flushed = false;
      let rejected: unknown;
      await t.flush().then(
        () => {
          flushed = true;
        },
        (err) => {
          rejected = err;
        },
      );
      consoleError.mockRestore();
      expect(flushed).toBe(false);
      expect(rejected).toBeInstanceOf(Error);
      expect(String(rejected)).toContain('ENOSPC');
      await t.close().catch(() => {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
