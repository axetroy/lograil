import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The plugin lazily imports '@opentelemetry/api'. We mock it to exercise the
// three branches: package absent (no-op), present but no active span, and an
// active span that injects traceId/spanId into metadata.
async function loadPlugin() {
  const mod = await import('../src/plugin/otel-trace.js');
  return mod.createOtelTracePlugin();
}

describe('createOtelTracePlugin', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is a no-op when @opentelemetry/api is absent', async () => {
    vi.doMock('@opentelemetry/api', () => {
      throw new Error('not installed');
    });
    const plugin = await loadPlugin();
    if (plugin.onInit) await plugin.onInit(undefined as never);
    const entry = { message: 'x', metadata: {} } as never;
    const out = plugin.onEntry?.(entry) as { metadata: Record<string, unknown> };
    expect(out.metadata).toEqual({});
  });

  it('leaves the entry unchanged when no span is active', async () => {
    vi.doMock('@opentelemetry/api', () => ({
      trace: {
        getActiveSpan: () => undefined,
      },
    }));
    const plugin = await loadPlugin();
    if (plugin.onInit) await plugin.onInit(undefined as never);
    const entry = { message: 'x', metadata: { a: 1 } } as never;
    const out = plugin.onEntry?.(entry) as { metadata: Record<string, unknown> };
    expect(out.metadata).toEqual({ a: 1 });
  });

  it('injects traceId/spanId from the active span (W3C-valid 32/16 hex)', async () => {
    vi.doMock('@opentelemetry/api', () => ({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            spanId: '00f067aa0ba902b7',
          }),
        }),
      },
    }));
    const plugin = await loadPlugin();
    if (plugin.onInit) await plugin.onInit(undefined as never);
    const entry = { message: 'x', metadata: {} } as never;
    const out = plugin.onEntry?.(entry) as { metadata: Record<string, unknown> };
    expect(out.metadata.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(out.metadata.spanId).toBe('00f067aa0ba902b7');
  });

  it('lowercases uppercase traceId/spanId (P2-11)', async () => {
    vi.doMock('@opentelemetry/api', () => ({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({
            traceId: '4BF92F3577B34DA6A3CE929D0E0E4736',
            spanId: '00F067AA0BA902B7',
          }),
        }),
      },
    }));
    const plugin = await loadPlugin();
    if (plugin.onInit) await plugin.onInit(undefined as never);
    const entry = { message: 'x', metadata: {} } as never;
    const out = plugin.onEntry?.(entry) as { metadata: Record<string, unknown> };
    expect(out.metadata.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(out.metadata.spanId).toBe('00f067aa0ba902b7');
  });

  it('skips all-zero traceId/spanId (W3C invalid sentinel, P2-11)', async () => {
    vi.doMock('@opentelemetry/api', () => ({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({
            traceId: '00000000000000000000000000000000',
            spanId: '0000000000000000',
          }),
        }),
      },
    }));
    const plugin = await loadPlugin();
    if (plugin.onInit) await plugin.onInit(undefined as never);
    const entry = { message: 'x', metadata: {} } as never;
    const out = plugin.onEntry?.(entry) as { metadata: Record<string, unknown> };
    // Both ids are all-zero → the W3C "no span" sentinel → nothing injected.
    expect(out.metadata).toEqual({});
  });

  it('skips malformed-length ids but keeps the other if valid (P2-11)', async () => {
    vi.doMock('@opentelemetry/api', () => ({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({
            traceId: 'abc', // too short → dropped
            spanId: '00f067aa0ba902b7', // valid → kept
          }),
        }),
      },
    }));
    const plugin = await loadPlugin();
    if (plugin.onInit) await plugin.onInit(undefined as never);
    const entry = { message: 'x', metadata: {} } as never;
    const out = plugin.onEntry?.(entry) as { metadata: Record<string, unknown> };
    expect(out.metadata.traceId).toBeUndefined();
    expect(out.metadata.spanId).toBe('00f067aa0ba902b7');
  });

  it('does not throw when spanContext() is missing', async () => {
    vi.doMock('@opentelemetry/api', () => ({
      trace: {
        getActiveSpan: () => ({}) as never,
      },
    }));
    const plugin = await loadPlugin();
    if (plugin.onInit) await plugin.onInit(undefined as never);
    const entry = { message: 'x', metadata: {} } as never;
    const out = plugin.onEntry?.(entry) as { metadata: Record<string, unknown> };
    expect(out.metadata).toEqual({});
  });
});
