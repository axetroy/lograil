import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OtlpTransport } from '../src/transport/otlp.js';
import type { LogEntry } from '../src/types.js';
import { LOG_LEVELS } from '../src/types.js';

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    level: LOG_LEVELS.info,
    levelName: 'info',
    message: 'hello',
    args: [{ a: 1 }],
    timestamp: 1_700_000_000_000,
    time: new Date(1_700_000_000_000).toISOString(),
    context: { tenant: 'acme' },
    metadata: {},
    ...over,
  };
}

describe('OtlpTransport', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('buffers entries and POSTs an OTLP payload on flush', async () => {
    const t = new OtlpTransport({ endpoint: 'http://collector/v1/logs', serviceName: 'demo' });
    t.write(makeEntry(), 'hello');
    t.write(makeEntry({ levelName: 'error', level: LOG_LEVELS.error }), 'boom');
    await t.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://collector/v1/logs');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.resourceLogs).toHaveLength(1);
    expect(body.resourceLogs[0].resource.attributes).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'demo' },
    });
    const records = body.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(2);
    expect(records[0].severityNumber).toBe(9); // INFO
    expect(records[0].body.stringValue).toBe('hello');
    expect(records[1].severityNumber).toBe(17); // ERROR
    expect(records[0].attributes).toContainEqual({ key: 'tenant', value: { stringValue: 'acme' } });
    expect(records[0].timeUnixNano).toBe(String(1_700_000_000_000 * 1_000_000));
  });

  it('flushes automatically when batchSize is reached', async () => {
    const t = new OtlpTransport({ batchSize: 2 });
    t.write(makeEntry(), 'a');
    t.write(makeEntry(), 'b');
    // reaching batchSize triggers an async flush; wait a tick for it to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports non-2xx responses via onError', async () => {
    const errors: unknown[] = [];
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal' });
    const t = new OtlpTransport({ onError: (e) => void errors.push(e) });
    t.write(makeEntry(), 'x');
    await t.flush();
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toContain('500');
  });
});
