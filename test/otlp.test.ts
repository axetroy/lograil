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

  it('reports non-2xx responses via onError (4xx fails fast, 5xx retries then fails)', async () => {
    // 4xx: client error, fails immediately without retry
    const errors4xx: unknown[] = [];
    fetchMock.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });
    const t4 = new OtlpTransport({ onError: (e) => void errors4xx.push(e), maxRetries: 3 });
    t4.write(makeEntry(), 'x');
    await t4.flush();
    expect(errors4xx).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 5xx: server error, retries maxRetries times then gives up
    const errors5xx: unknown[] = [];
    const callsBefore = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal' });
    const t5 = new OtlpTransport({ onError: (e) => void errors5xx.push(e), maxRetries: 2 });
    t5.write(makeEntry(), 'y');
    await t5.flush();
    expect(errors5xx).toHaveLength(1);
    // maxRetries=2: attempt1(1>2 false→retry), attempt2(2>2 false→retry), attempt3(3>2 true→drop)
    // = 3 fetch calls for this transport only
    expect(fetchMock.mock.calls.length - callsBefore).toBe(3);
    expect(String((errors5xx[0] as Error).message)).toContain('500');
  });

  it('maps traceId/spanId context into OTLP trace fields', async () => {
    const t = new OtlpTransport();
    t.write(makeEntry({ context: { tenant: 'acme', traceId: 'abc123', spanId: 'def456' } }), 'hi');
    await t.flush();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const rec = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(rec.traceId).toBe('abc123');
    expect(rec.spanId).toBe('def456');
    // trace fields must NOT also appear as plain attributes
    expect(rec.attributes.find((a: { key: string }) => a.key === 'traceId')).toBeUndefined();
    expect(rec.attributes.find((a: { key: string }) => a.key === 'spanId')).toBeUndefined();
    expect(rec.attributes).toContainEqual({ key: 'tenant', value: { stringValue: 'acme' } });
  });

  it('accepts trace_id/span_id underscore form', async () => {
    const t = new OtlpTransport();
    t.write(makeEntry({ context: { trace_id: 'aa', span_id: 'bb' } }), 'hi');
    await t.flush();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const rec = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(rec.traceId).toBe('aa');
    expect(rec.spanId).toBe('bb');
  });

  it('reads trace ids from metadata when absent from context', async () => {
    const t = new OtlpTransport();
    t.write(makeEntry({ context: {}, metadata: { traceId: 'm1', spanId: 'm2' } }), 'hi');
    await t.flush();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const rec = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(rec.traceId).toBe('m1');
    expect(rec.spanId).toBe('m2');
  });

  it('emits doubleValue for non-integer numbers', async () => {
    const t = new OtlpTransport();
    t.write(makeEntry({ context: { ratio: 0.5 } }), 'hi');
    await t.flush();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const rec = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    const attr = rec.attributes.find((a: { key: string }) => a.key === 'ratio');
    expect(attr.value.doubleValue).toBe(0.5);
  });

  it('appends resource attributes and honors service.name override', async () => {
    const t = new OtlpTransport({ resource: { 'deployment.environment': 'prod' } });
    t.write(makeEntry(), 'hi');
    await t.flush();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    const attrs = body.resourceLogs[0].resource.attributes;
    expect(attrs).toContainEqual({ key: 'service.name', value: { stringValue: 'lograil' } });
    expect(attrs).toContainEqual({
      key: 'deployment.environment',
      value: { stringValue: 'prod' },
    });
  });

  it('clamps a non-positive batchSize to the default (100)', async () => {
    const t = new OtlpTransport({ batchSize: 0 });
    // Should not throw; buffers up to the default and only flushes on close.
    t.write(makeEntry(), 'hi');
    await t.close();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('flush is a no-op when the queue is empty', async () => {
    const t = new OtlpTransport();
    await expect(t.flush()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a network error (fetch rejection) via onError (retries then fails)', async () => {
    const errors: unknown[] = [];
    const callsBefore = fetchMock.mock.calls.length;
    fetchMock.mockRejectedValue(new Error('network down'));
    const t = new OtlpTransport({ onError: (e) => void errors.push(e), maxRetries: 1 });
    t.write(makeEntry(), 'x');
    await t.flush();
    expect(errors).toHaveLength(1);
    // attempt=0 fail → requeue, attempt=1 >= maxRetries(1) → drop. 2 fetch calls.
    expect(fetchMock).toHaveBeenCalledTimes(callsBefore + 2);
    expect(String((errors[0] as Error).message)).toContain('network down');
  });

  it('drains entries queued while a flush is already in flight', async () => {
    let resolveFirst: (() => void) | undefined;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = () => resolve({ ok: true, status: 200, statusText: 'OK' });
          }),
      )
      .mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });

    const t = new OtlpTransport({ batchSize: 1 });
    t.write(makeEntry({ message: 'first' }), 'first');
    t.write(makeEntry({ message: 'second' }), 'second');
    resolveFirst?.();
    await t.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-queues batch on network error and retries', async () => {
    const errors: unknown[] = [];
    const callsBefore = fetchMock.mock.calls.length;
    // First 3 calls fail, 4th succeeds
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount <= 3) return Promise.reject(new Error('network down'));
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK' });
    });
    const t = new OtlpTransport({
      onError: (e) => void errors.push(e),
      maxRetries: 3,
      retryInitialDelayMs: 2,
    });
    t.write(makeEntry({ message: 'retry-me' }), 'x');
    await t.flush();

    // attempt 0,1,2 fail (3 retries), attempt=3 succeeds → 4 fetch calls total
    expect(fetchMock).toHaveBeenCalledTimes(callsBefore + 4);
    expect(errors).toHaveLength(0);
  });

  it('drops batch after exhausting retries and increments dropCount', async () => {
    const errors: unknown[] = [];
    const callsBefore = fetchMock.mock.calls.length;
    fetchMock.mockRejectedValue(new Error('network down'));
    const t = new OtlpTransport({
      onError: (e) => void errors.push(e),
      maxRetries: 1,
      retryInitialDelayMs: 2,
    });
    t.write(makeEntry({ message: 'lost' }), 'x');
    await t.flush();

    // attempt=0 fail, attempt=1 >= maxRetries(1) → drop. 2 fetch calls.
    expect(fetchMock).toHaveBeenCalledTimes(callsBefore + 2);
    expect(t.dropCount).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('does not retry on 4xx client errors', async () => {
    const errors: unknown[] = [];
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    const t = new OtlpTransport({
      onError: (e) => void errors.push(e),
      maxRetries: 5,
    });
    t.write(makeEntry(), 'x');
    await t.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(t.dropCount).toBe(0); // 4xx is not a drop — it's a permanent error
    expect(errors).toHaveLength(1);
  });

  describe('queue overflow (maxQueueSize)', () => {
    it('drops the newest entry when the queue is full', async () => {
      const t = new OtlpTransport({ maxQueueSize: 3, batchSize: 100 });
      t.write(makeEntry({ message: 'a' }), 'a');
      t.write(makeEntry({ message: 'b' }), 'b');
      t.write(makeEntry({ message: 'c' }), 'c');
      // 4th write should be dropped
      t.write(makeEntry({ message: 'd' }), 'd');

      expect(t.overflowDropCount).toBe(1);
      expect(t.bufferLength).toBe(3);

      await t.flush();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      const records = body.resourceLogs[0].scopeLogs[0].logRecords;
      expect(records).toHaveLength(3);
      expect(records.map((r: { body: { stringValue: string } }) => r.body.stringValue)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('calls onQueueOverflow with the entry and queue depth', async () => {
      const overflows: { message: string; depth: number }[] = [];
      const t = new OtlpTransport({
        maxQueueSize: 2,
        onQueueOverflow: (entry, depth) => overflows.push({ message: entry.message, depth }),
      });
      t.write(makeEntry({ message: 'ok1' }), 'ok1');
      t.write(makeEntry({ message: 'ok2' }), 'ok2');
      t.write(makeEntry({ message: 'drop1' }), 'drop1');
      t.write(makeEntry({ message: 'drop2' }), 'drop2');

      expect(overflows).toEqual([
        { message: 'drop1', depth: 2 },
        { message: 'drop2', depth: 2 },
      ]);
      expect(t.overflowDropCount).toBe(2);
    });

    it('does not call onQueueOverflow when under the limit', async () => {
      let called = false;
      const t = new OtlpTransport({
        maxQueueSize: 10,
        onQueueOverflow: () => {
          called = true;
        },
      });
      t.write(makeEntry(), 'ok');
      t.write(makeEntry(), 'ok');
      expect(called).toBe(false);
      expect(t.overflowDropCount).toBe(0);
    });

    it('maxQueueSize: 0 disables the limit', () => {
      const t = new OtlpTransport({ maxQueueSize: 0, batchSize: 501 });
      for (let i = 0; i < 500; i++) {
        t.write(makeEntry({ message: `m${i}` }), `m${i}`);
      }
      expect(t.overflowDropCount).toBe(0);
      expect(t.bufferLength).toBe(500);
    });

    it('default maxQueueSize is 10_000', () => {
      const t = new OtlpTransport({ batchSize: 10_001 });
      // Fill to 10_000 — should not drop
      for (let i = 0; i < 10_000; i++) {
        t.write(makeEntry(), 'x');
      }
      expect(t.overflowDropCount).toBe(0);
      expect(t.bufferLength).toBe(10_000);
      // 10_001st entry should drop
      t.write(makeEntry(), 'overflow');
      expect(t.overflowDropCount).toBe(1);
      expect(t.bufferLength).toBe(10_000);
    });

    it('bufferLength reflects queue state after flush', async () => {
      const t = new OtlpTransport({ maxQueueSize: 6, batchSize: 6 });
      for (let i = 0; i < 5; i++) {
        t.write(makeEntry({ message: `m${i}` }), `m${i}`);
      }
      expect(t.bufferLength).toBe(5);
      await t.flush();
      expect(t.bufferLength).toBe(0);
    });
  });
});
