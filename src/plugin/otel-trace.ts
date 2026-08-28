import type { LogEntry } from '../types.js';
import type { Plugin } from './plugin.js';

/**
 * Minimal shape of the `@opentelemetry/api` `trace` namespace that we use. We
 * avoid importing the package at the type level so the library stays usable
 * without it installed; the dependency is resolved lazily at runtime.
 */
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
      try {
        // Lazy, optional resolution — never fails if the package is absent.
        // The specifier is held in a variable so TypeScript does not try to
        // resolve the (optional) module at compile time.
        const specifier = '@opentelemetry/api';
        const mod = (await import(specifier)) as unknown as { trace?: OtelTraceApi };
        traceApi = mod.trace;
      } catch {
        traceApi = undefined;
      }
    },
    onEntry(entry: LogEntry) {
      if (!traceApi) return entry;
      const span = traceApi.getActiveSpan();
      if (!span) return entry;
      const ctx = span.spanContext();
      if (!ctx) return entry;
      return {
        ...entry,
        metadata: { ...entry.metadata, traceId: ctx.traceId, spanId: ctx.spanId },
      };
    },
  };
}
