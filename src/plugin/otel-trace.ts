import type { LogEntry } from '../types.js';
import type { Plugin } from './plugin.js';

interface OtelTraceApi {
  getActiveSpan(): { spanContext(): { traceId: string; spanId: string } } | undefined;
}

/**
 * Plugin that injects the active OpenTelemetry trace/span identifiers into each
 * entry's `metadata` (`traceId` / `spanId`), so an `OtlpTransport` (or any
 * backend that reads those fields) can correlate logs with their span without
 * you having to thread the context manually.
 *
 * `@opentelemetry/api` is an **optional** peer dependency: if it isn't installed,
 * or no span is active, the plugin is a no-op and entries are unaffected. Load
 * it once via `logger.use(createOtelTracePlugin())`.
 *
 * @example
 * import { trace } from '@opentelemetry/api';
 * const span = tracer.startSpan('op');
 * trace.setSpan(context.active(), span);
 * logger.info('inside span'); // => metadata: { traceId, spanId }
 */
export function createOtelTracePlugin(): Plugin {
  let traceApi: OtelTraceApi | undefined;
  return {
    name: 'otel-trace',
    async onInit() {
      // Dynamic import with a variable literal prevents TS from resolving the
      // optional peer dependency at compile time.
      try {
        traceApi = (await import('@opentelemetry/api')).trace as OtelTraceApi | undefined;
      } catch {
        // Not installed — plugin stays a no-op.
      }
    },
    onEntry(entry: LogEntry) {
      if (!traceApi) return entry;
      const span = traceApi.getActiveSpan();
      if (!span) return entry;
      // Some tracer implementations return a span object without a
      // `spanContext` method; tolerate that instead of throwing on the hot
      // path.
      if (typeof span.spanContext !== 'function') return entry;
      const ctx = span.spanContext();
      if (!ctx) return entry;
      return {
        ...entry,
        metadata: { ...entry.metadata, traceId: ctx.traceId, spanId: ctx.spanId },
      };
    },
  };
}
