import { describe, it, expect, vi } from 'vitest';
import { formatMessage } from '../src/core/printf.js';
import { createLineFormatter } from '../src/pipeline/formatter.js';
import { OtlpTransport } from '../src/transport/otlp.js';
import { RotatingFileTransport } from '../src/transport/rotating-file.js';
import type { LogEntry } from '../src/types.js';
import { LOG_LEVELS } from '../src/types.js';

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    level: LOG_LEVELS.info,
    levelName: 'info',
    message: 'hello',
    args: [],
    timestamp: 1_700_000_000_000,
    time: new Date(1_700_000_000_000).toISOString(),
    context: {},
    metadata: {},
    ...over,
  };
}

describe('printf - non-specifier % is emitted literally', () => {
  it('keeps a trailing %x verbatim (advances one char past %)', () => {
    expect(formatMessage('a%xb', [])[0]).toBe('a%xb');
  });
});

describe('formatter - error cause chains in args and entry', () => {
  it('renders an Error arg with a cause inline (short form)', () => {
    const cause = new Error('root');
    const err = new Error('boom');
    (err as unknown as { cause: unknown }).cause = cause;
    const fmt = createLineFormatter();
    const out = fmt(makeEntry({ args: [err] }));
    expect(out).toContain('boom');
    expect(out).toContain('root');
  });
});

describe('OtlpTransport - null attribute and pid', () => {
  it('serializes a null/undefined context value to an empty string and adds pid', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);
    const t = new OtlpTransport();
    t.write(makeEntry({ context: { x: null }, pid: 4242 }), 'hi');
    await t.flush();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const rec = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    const nullAttr = rec.attributes.find((a: { key: string }) => a.key === 'x');
    expect(nullAttr.value.stringValue).toBe('');
    expect(rec.attributes).toContainEqual({ key: 'pid', value: { intValue: '4242' } });
    vi.unstubAllGlobals();
  });
});

describe('RotatingFileTransport - custom now and extension base', () => {
  it('uses the provided now() and handles a path with an extension', async () => {
    const { mkdtemp, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'elog-edge-'));
    try {
      const file = join(dir, 'app.log');
      const clock = new Date(2024, 0, 1, 0, 0, 0, 0);
      const transport = new RotatingFileTransport({
        path: file,
        daily: true,
        now: () => clock,
      });
      transport.write(
        makeEntry({ message: 'one' }),
        transport.formatter!(makeEntry({ message: 'one' })),
      );
      await transport.close();
      const content = (await readFile(join(dir, 'app.2024-01-01.01.log'), 'utf8')).trim();
      expect(content).toContain('one');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
