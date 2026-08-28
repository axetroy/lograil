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

/** Flatten a plain object into an array of OTLP {@link OtlpAttribute}s. */
function toAttributes(record: Record<string, unknown>): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  for (const key of Object.keys(record)) {
    out.push({ key, value: toOtlpValue(record[key]) });
  }
  return out;
}

/**
 * Map a lograil {@link LogEntry} to an OTLP `LogRecord`.
 * Context and metadata become attributes; `scope` and `pid` are added when
 * present. The timestamp is converted from millisecond epoch to nanosecond
 * string; the message becomes the record body.
 */
function toLogRecord(entry: LogEntry): OtlpLogRecord {
  const attributes: OtlpAttribute[] = [
    ...toAttributes(entry.context),
    ...toAttributes(entry.metadata),
  ];
  if (entry.scope) attributes.push({ key: 'scope', value: { stringValue: entry.scope } });
  if (typeof entry.pid === 'number') {
    attributes.push({ key: 'pid', value: { intValue: String(entry.pid) } });
  }
  return {
    timeUnixNano: String(entry.timestamp * 1_000_000),
    severityNumber: SEVERITY[entry.levelName],
    severityText: entry.levelName.toUpperCase(),
    body: { stringValue: entry.message },
    attributes,
  };
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
}

/**
 * A {@link Transport} that forwards log entries to an OpenTelemetry Collector
 * (or any OTLP HTTP/JSON receiver) via `POST /v1/logs`.
 *
 * Entries are buffered in memory and sent in batches; call {@link flush} (or
 * enable `autoFlushOnExit` on the logger) to drain them before the process
 * exits. It uses the global `fetch`, so it requires Node >= 18, a modern
 * browser, or Electron. Nothing is transmitted synchronously — `write` only
 * enqueues, so it is always safe to call from hot paths.
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
  private readonly errorHandler: (err: unknown) => void;
  private readonly resourceAttributes: OtlpAttribute[];
  private queue: OtlpLogRecord[] = [];
  private flushing = false;

  constructor(options: OtlpTransportOptions = {}) {
    this.name = 'otlp';
    this.formatter = options.formatter;
    this.endpoint = options.endpoint ?? 'http://localhost:4318/v1/logs';
    this.headers = { 'content-type': 'application/json', ...options.headers };
    this.scopeName = options.scopeName ?? 'lograil';
    this.batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 100;
    this.errorHandler =
      options.onError ?? ((err) => console.error('[lograil] OTLP send failed:', err));
    const resource: Record<string, unknown> = { 'service.name': options.serviceName ?? 'lograil' };
    if (options.resource) Object.assign(resource, options.resource);
    this.resourceAttributes = toAttributes(resource);
  }

  /**
   * Enqueue an entry for delivery. When the buffer reaches `batchSize` an
   * asynchronous flush is kicked off (its result is intentionally unawaited).
   * @param entry The structured log entry to forward.
   * @param _formatted The pipeline-formatted string (unused by OTLP).
   */
  write(entry: LogEntry, _formatted: string): void {
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
   * Send the buffered batch to the OTLP endpoint and clear the queue. Safe to
   * call repeatedly — no-op while already flushing or when the queue is empty.
   * On a non-2xx response or network error, `errorHandler` is invoked.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue;
    this.queue = [];
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(this.buildPayload(batch)),
      });
      if (!res.ok) {
        this.errorHandler(new Error(`OTLP HTTP ${res.status} ${res.statusText}`));
      }
    } catch (err) {
      this.errorHandler(err);
    } finally {
      this.flushing = false;
    }
  }

  /** Tear down the transport by flushing any remaining buffered entries. */
  async close(): Promise<void> {
    await this.flush();
  }
}
