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

  it('injects traceId/spanId from the active span', async () => {
    vi.doMock('@opentelemetry/api', () => ({
      trace: {
        getActiveSpan: () => ({
          spanContext: () => ({ traceId: 'abc', spanId: 'def' }),
        }),
      },
    }));
    const plugin = await loadPlugin();
    if (plugin.onInit) await plugin.onInit(undefined as never);
    const entry = { message: 'x', metadata: {} } as never;
    const out = plugin.onEntry?.(entry) as { metadata: Record<string, unknown> };
    expect(out.metadata.traceId).toBe('abc');
    expect(out.metadata.spanId).toBe('def');
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
