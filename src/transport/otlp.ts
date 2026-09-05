import type { LogEntry, LogLevelName } from '../types.js';
import type { Formatter } from '../pipeline/formatter.js';
import type { Transport } from './transport.js';

/**
 * OTLP severity numbers (a subset of the OpenTelemetry spec) mapped from our
 * level names. The numbers preserve OTLP ordering so backends can filter by
 * minimum severity:
 * `trace=1, debug=5, info=9, warn=13, error=17, fatal=21`.
 */
const SEVERITY: Record<LogLevelName, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

/** A subset of the OTLP `AnyValue` JSON shape we emit (string/int/double/bool). */
interface OtlpValue {
  /** UTF-8 string value. */
  stringValue?: string;
  /** Integer value, encoded as a decimal string per the OTLP JSON spec. */
  intValue?: string;
  /** Floating-point value. */
  doubleValue?: number;
  /** Boolean value. */
  boolValue?: boolean;
}

/** A single OTLP attribute: a key paired with a typed {@link OtlpValue}. */
interface OtlpAttribute {
  /** Attribute key (e.g. `tenant`, `pid`, `code.filepath`). */
  key: string;
  /** Typed value of the attribute. */
  value: OtlpValue;
}

/** The OTLP `LogRecord` JSON shape for one emitted log entry. */
interface OtlpLogRecord {
  /** Timestamp in nanoseconds since the Unix epoch (string-encoded integer). */
  timeUnixNano: string;
  /** OTLP severity number, see {@link SEVERITY}. */
  severityNumber: number;
  /** Human-readable severity, e.g. `INFO` (our upper-cased level name). */
  severityText: string;
  /** The log message body. */
  body: { stringValue: string };
  /** Structured attributes derived from context / metadata / scope / pid. */
  attributes: OtlpAttribute[];
  /**
   * 16-byte trace id (hex string) lifted from `context.traceId` /
   * `context.trace_id`, so the log joins a distributed trace in the backend.
   */
  traceId?: string;
  /**
   * 8-byte span id (hex string) lifted from `context.spanId` /
   * `context.span_id`.
   */
  spanId?: string;
}

/**
 * Convert an arbitrary JS value into the OTLP `AnyValue` shape.
 * - `string` → `stringValue`
 * - `boolean` → `boolValue`
 * - integer `number` → `intValue` (decimal string, per spec); other numbers → `doubleValue`
 * - `null` / `undefined` → empty `stringValue`
 * - everything else (objects, arrays, `Error`, …) → JSON `stringValue`
 */
function toOtlpValue(value: unknown): OtlpValue {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (value === null || value === undefined) return { stringValue: '' };
  return { stringValue: JSON.stringify(value) };
}

/** Context/metadata keys (any casing / underscore form) mapped to OTLP trace fields. */
const TRACE_KEYS = new Set(['traceid', 'trace_id', 'spanid', 'span_id']);

/**
 * Flatten `record` into OTLP attributes, skipping the reserved trace-correlation
 * keys (which are lifted to the dedicated `traceId`/`spanId` fields instead).
 * Returns `undefined` when the record contributes no attributes, so the caller
 * can avoid allocating an intermediate array for empty records.
 */
function collectAttributes(record: Record<string, unknown>): OtlpAttribute[] | undefined {
  let out: OtlpAttribute[] | undefined;
  for (const key of Object.keys(record)) {
    if (TRACE_KEYS.has(key.toLowerCase())) continue;
    (out ??= []).push({ key, value: toOtlpValue(record[key]) });
  }
  return out;
}

/** Read a non-empty string value for one of several candidate key names. */
function pickString(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = record[n];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Map a lograil {@link LogEntry} to an OTLP `LogRecord`.
 * Context and metadata become attributes; `scope` and `pid` are added when
 * present. `traceId` / `spanId` (also accepted as `trace_id` / `span_id`) are
 * lifted out of the attributes into OTLP's dedicated `traceId` / `spanId`
 * fields so the log correlates with distributed traces. The timestamp is
 * converted from millisecond epoch to nanosecond string; the message becomes
 * the record body.
 */
function toLogRecord(entry: LogEntry): OtlpLogRecord {
  const attributes: OtlpAttribute[] = [];
  // Single pass per source: collect attributes and (for context) harvest the
  // trace ids in the same traversal, avoiding the prior double flatten + filter
  // + per-key `toLowerCase()` churn.
  const ctxAttrs = collectAttributes(entry.context);
  if (ctxAttrs) for (const a of ctxAttrs) attributes.push(a);
  const metaAttrs = collectAttributes(entry.metadata);
  if (metaAttrs) for (const a of metaAttrs) attributes.push(a);
  if (entry.scope) attributes.push({ key: 'scope', value: { stringValue: entry.scope } });
  if (typeof entry.pid === 'number') {
    attributes.push({ key: 'pid', value: { intValue: String(entry.pid) } });
  }
  const record: OtlpLogRecord = {
    timeUnixNano: String(entry.timestamp * 1_000_000),
    severityNumber: SEVERITY[entry.levelName],
    severityText: entry.levelName.toUpperCase(),
    body: { stringValue: entry.message },
    attributes,
  };
  const traceId =
    pickString(entry.context, 'traceId', 'trace_id') ??
    pickString(entry.metadata, 'traceId', 'trace_id');
  const spanId =
    pickString(entry.context, 'spanId', 'span_id') ??
    pickString(entry.metadata, 'spanId', 'span_id');
  if (traceId) record.traceId = traceId;
  if (spanId) record.spanId = spanId;
  return record;
}

/** Configuration for {@link OtlpTransport}. */
export interface OtlpTransportOptions {
  /**
   * OTLP HTTP/JSON endpoint to `POST` batches to.
   * @default `'http://localhost:4318/v1/logs'` (the OpenTelemetry Collector's
   * default HTTP receiver).
   */
  endpoint?: string;
  /**
   * Extra HTTP headers sent with every request (e.g. `Authorization` for an
   * OTLP gateway). `content-type: application/json` is always set for you.
   */
  headers?: Record<string, string>;
  /**
   * Resource attributes attached to every batch (e.g. `service.version`,
   * `deployment.environment`). They are merged on top of `service.name`; values
   * here win on key collision.
   */
  resource?: Record<string, unknown>;
  /**
   * Value of the `service.name` resource attribute.
   * @default `'lograil'`
   */
  serviceName?: string;
  /**
   * Scope name reported to OTLP (the instrumentation scope). Useful to
   * distinguish this logger from other emitters in the same collector.
   * @default `'lograil'`
   */
  scopeName?: string;
  /**
   * Optional per-transport formatter. When set it overrides the pipeline's
   * default formatter for this transport only (unused by OTLP, which serializes
   * the structured entry itself, but kept for interface parity).
   */
  formatter?: Formatter;
  /**
   * Maximum number of entries buffered before an automatic (async) flush is
   * triggered. `1` sends every entry immediately; higher values batch more.
   * @default `100`
   */
  batchSize?: number;
  /**
   * Callback invoked when a request fails (network error or non-2xx response).
   * Receives the raw error / `Error('OTLP HTTP <status> <statusText>')`.
   * @default `console.error`
   */
  onError?: (err: unknown) => void;
  /**
   * Number of retry attempts per batch on transient failure (network error or
   * 5xx). Retries use exponential backoff starting at `retryInitialDelayMs`.
   * `0` disables retries (immediate fail-fast). Default `3`.
   */
  maxRetries?: number;
  /**
   * Initial backoff delay (ms) before the first retry. Subsequent retries
   * double this delay up to `retryMaxDelayMs`. Default `250`.
   */
  retryInitialDelayMs?: number;
  /**
   * Maximum backoff delay (ms) between retries. Default `5000`.
   */
  retryMaxDelayMs?: number;
  /**
   * Maximum number of entries that can be buffered in memory. When the queue
   * is full, the **newest** entry is dropped immediately and {@link onQueueOverflow}
   * is called (if provided). `0` disables the limit (not recommended for
   * long-running services). Default `10_000`.
   */
  maxQueueSize?: number;
  /**
   * Called when an entry is dropped because the internal queue is full.
   * Receives the original log entry and the current queue depth.
   */
  onQueueOverflow?(entry: LogEntry, queueDepth: number): void;
}

/**
 * A {@link Transport} that forwards log entries to an OpenTelemetry Collector
 * (or any OTLP HTTP/JSON receiver) via `POST /v1/logs`.
 *
 * Entries are buffered in memory and sent in batches; call {@link flush} (or
 * enable `autoFlushOnExit` on the logger) to drain them before the process
 * exits. It uses the global `fetch`, so it requires Node >= 18, a modern
 * browser, or Electron. Nothing is transmitted synchronously — `write` only
 * enqueues, so it is always safe to call from hot paths. Context fields
 * `traceId` / `spanId` (or `trace_id` / `span_id`) are mapped to OTLP's trace
 * correlation fields automatically.
 */
export class OtlpTransport implements Transport {
  /** Transport name, fixed to `'otlp'`. */
  readonly name: string;
  /** Optional per-transport formatter (interface parity; OTLP ignores it). */
  readonly formatter?: Formatter;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly scopeName: string;
  private readonly batchSize: number;
  private errorHandler: (err: unknown) => void;
  private readonly resourceAttributes: OtlpAttribute[];
  private queue: OtlpLogRecord[] = [];
  private flushPromise: Promise<void> | null = null;
  /** Count of batches that were dropped after exhausting all retries. */
  dropCount = 0;
  /** Count of individual entries dropped due to queue overflow. */
  overflowDropCount = 0;
  private readonly maxRetries: number;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly maxQueueSize: number;
  private onQueueOverflow: ((entry: LogEntry, queueDepth: number) => void) | undefined;
  /** Optional per-transport queue limit enforced by the Logger dispatch. */
  queueLimit?: number;
  /** Optional overflow callback wired from the Logger dispatch. */
  onOverflow?: (entry: LogEntry, queueDepth: number) => void;

  constructor(options: OtlpTransportOptions = {}) {
    this.name = 'otlp';
    this.formatter = options.formatter;
    this.endpoint = options.endpoint ?? 'http://localhost:4318/v1/logs';
    this.headers = { 'content-type': 'application/json', ...options.headers };
    this.scopeName = options.scopeName ?? 'lograil';
    this.batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 100;
    this.errorHandler =
      options.onError ?? ((err) => console.error('[lograil] OTLP send failed:', err));
    const maxRetries =
      options.maxRetries !== undefined && options.maxRetries > 0 ? options.maxRetries : 3;
    this.retryInitialDelayMs = options.retryInitialDelayMs ?? 250;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 5000;
    this.maxRetries = maxRetries;
    this.maxQueueSize =
      options.maxQueueSize !== undefined && options.maxQueueSize > 0
        ? options.maxQueueSize
        : 10_000;
    this.onQueueOverflow = options.onQueueOverflow;
    const resource: Record<string, unknown> = { 'service.name': options.serviceName ?? 'lograil' };
    if (options.resource) Object.assign(resource, options.resource);
    this.resourceAttributes = collectAttributes(resource) ?? [];
  }

  /**
   * Enqueue an entry for delivery. When the buffer reaches `batchSize` an
   * asynchronous flush is kicked off (its result is intentionally unawaited).
   * @param entry The structured log entry to forward.
   * @param _formatted The pipeline-formatted string (unused by OTLP).
   */
  write(entry: LogEntry, _formatted: string): void {
    // Backpressure: drop the newest entry when the internal queue is full.
    if (this.maxQueueSize > 0 && this.queue.length >= this.maxQueueSize) {
      this.overflowDropCount++;
      if (this.onQueueOverflow) this.onQueueOverflow(entry, this.queue.length);
      return;
    }
    this.queue.push(toLogRecord(entry));
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }

  /** Assemble the full OTLP `LogsData` JSON envelope for a batch of records. */
  private buildPayload(records: OtlpLogRecord[]): unknown {
    return {
      resourceLogs: [
        {
          resource: { attributes: this.resourceAttributes },
          scopeLogs: [{ scope: { name: this.scopeName }, logRecords: records }],
        },
      ],
    };
  }

  /**
   * Send the buffered batch to the OTLP endpoint. On transient failure (network
   * error or 5xx), the batch is re-queued and retried with exponential backoff
   * up to {@link OtlpTransportOptions.maxRetries}. After exhausting retries the
   * batch is dropped and {@link dropCount} is incremented.
   *
   * Safe to call repeatedly — no-op while already flushing or when the queue is
   * empty. Non-transient errors (4xx) fail fast without retry.
   */
  async flush(): Promise<void> {
    // no-op if already flushing or queue is empty
    if (this.flushPromise !== null || this.queue.length === 0) return;
    this.flushPromise = (async () => {
      while (this.queue.length > 0) {
        // grab a snapshot of the current queue as the batch to send.
        // entries written after this point go into the next iteration.
        const batch = this.queue.splice(0);
        let delay = this.retryInitialDelayMs;
        for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
          try {
            const res = await fetch(this.endpoint, {
              method: 'POST',
              headers: this.headers,
              body: JSON.stringify(this.buildPayload(batch)),
            });
            if (res.ok) break; // success — batch consumed
            // 4xx: client error, fail fast (no retry)
            if (res.status < 500) {
              this.errorHandler(new Error(`OTLP HTTP ${res.status} ${res.statusText}`));
              break;
            }
            // transient server error — retry or give up
            if (attempt > this.maxRetries) {
              this.dropCount++;
              this.errorHandler(new Error(`OTLP HTTP ${res.status} after ${attempt - 1} retries`));
              break;
            }
            await this.sleep(delay);
            delay = Math.min(delay * 2, this.retryMaxDelayMs);
            // stay in the for-loop: next iteration re-uses the same batch
          } catch (err) {
            // network error — retry or give up
            if (attempt > this.maxRetries) {
              this.dropCount++;
              this.errorHandler(err);
              break;
            }
            await this.sleep(delay);
            delay = Math.min(delay * 2, this.retryMaxDelayMs);
            // stay in the for-loop: next iteration re-uses the same batch
          }
        }
      }
    })().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Tear down the transport by flushing any remaining buffered entries. */
  async close(): Promise<void> {
    await this.flush();
  }

  /** Current number of entries waiting to be flushed. */
  get bufferLength(): number {
    return this.queue.length;
  }
}
