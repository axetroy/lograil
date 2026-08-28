import type { LogEntry, LogFn, LoggerMethods, LogLevelInput, LogLevelName } from '../types.js';
import { LOG_LEVELS, normalizeLevel } from '../types.js';
import type { RuntimeAdapter } from '../runtime/index.js';
import { detectRuntime } from '../runtime/index.js';
import type { PipelineOptions } from '../pipeline/pipeline.js';
import { Pipeline } from '../pipeline/pipeline.js';
import type { Formatter } from '../pipeline/formatter.js';
import { createLineFormatter } from '../pipeline/formatter.js';
import type { Transport } from '../transport/transport.js';
import type { Plugin, PluginContext } from '../plugin/index.js';
import { PluginManager } from '../plugin/index.js';
import type { ContextStore } from '../context/index.js';
import { createContextStore } from '../context/index.js';

function pad(n: number, len: number): string {
  let s = String(n);
  while (s.length < len) s = `0${s}`;
  return s;
}

// Reused across entries so the timestamp formatter never allocates a `Date`
// per log line (single-threaded: `setTime` + UTC reads run synchronously).
const TIME_DATE = new Date();

/**
 * Format a millisecond epoch timestamp as an ISO-8601 UTC string
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`). A single `Date` is reused for the calendar
 * decomposition, avoiding a per-entry allocation; only the string is built.
 */
function isoFromMs(ms: number): string {
  TIME_DATE.setTime(ms);
  return `${pad(TIME_DATE.getUTCFullYear(), 4)}-${pad(TIME_DATE.getUTCMonth() + 1, 2)}-${pad(
    TIME_DATE.getUTCDate(),
    2,
  )}T${pad(TIME_DATE.getUTCHours(), 2)}:${pad(TIME_DATE.getUTCMinutes(), 2)}:${pad(
    TIME_DATE.getUTCSeconds(),
    2,
  )}.${pad(TIME_DATE.getUTCMilliseconds(), 3)}Z`;
}

export interface LoggerOptions {
  /** Minimum level to emit. Default `info`. */
  level?: LogLevelInput;
  /** Optional scope / namespace for this logger. */
  scope?: string;
  /** Runtime adapter. Auto-detected when omitted. */
  runtime?: RuntimeAdapter;
  /** Initial context store. */
  context?: ContextStore;
  /** Transports. Defaults to the runtime's default transports. */
  transports?: Transport[];
  /** Pipeline configuration or instance. */
  pipeline?: Pipeline | PipelineOptions;
  /** Shared plugin manager. Internal: used by {@link scope}. */
  plugins?: PluginManager;
}

/**
 * Unified logging facade. Produces {@link LogEntry} records, runs them through
 * the {@link Pipeline} (filter + processors), lets {@link Plugin}s intercept,
 * formats and writes them to {@link Transport}s.
 *
 * Instances are cheap to derive via {@link scope}; all children share the same
 * transports, pipeline and plugins, but carry their own scope and context.
 */
export class Logger implements LoggerMethods {
  private runtime: RuntimeAdapter;
  private pipeline: Pipeline;
  private plugins: PluginManager;
  private transports: Transport[];
  private context: ContextStore;
  private level: number;
  private scopeName?: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private destroyed = false;
  private detachReceiver?: () => void;

  constructor(options: LoggerOptions = {}) {
    this.runtime = options.runtime ?? detectRuntime();
    const pipelineOpts = options.pipeline instanceof Pipeline ? undefined : options.pipeline;
    this.pipeline =
      options.pipeline instanceof Pipeline ? options.pipeline : new Pipeline(pipelineOpts ?? {});
    if (!(options.pipeline instanceof Pipeline) && !pipelineOpts?.formatter) {
      this.pipeline.setFormatter(createLineFormatter());
    }
    this.plugins = options.plugins ?? new PluginManager(this.buildPluginContext());
    this.transports = options.transports ?? this.runtime.defaultTransports();
    this.context = options.context ?? createContextStore();
    this.level = normalizeLevel(options.level ?? 'info');
    this.scopeName = options.scope;

    // On the Electron main process, receive renderer logs over IPC.
    if (this.runtime.attachReceiver) {
      this.detachReceiver = this.runtime.attachReceiver((entry) => this.ingestEntry(entry));
    }
  }

  /**
   * Feed an externally produced {@link LogEntry} (e.g. received from a renderer
   * process over IPC) into the pipeline/transports. Subject to the configured
   * level and plugins, then written via the active transports.
   */
  ingestEntry(entry: LogEntry): void {
    if (this.destroyed) return;
    if (entry.level < this.level) return;
    this.dispatch(entry);
  }

  // ---- Level ----

  getLevel(): number {
    return this.level;
  }

  setLevel(level: LogLevelInput): void {
    this.level = normalizeLevel(level);
  }

  // ---- Context ----

  setContext(key: string, value: unknown): void {
    this.context.set(key, value);
  }

  mergeContext(values: Record<string, unknown>): void {
    this.context.merge(values);
  }

  // ---- Transports ----

  addTransport(transport: Transport): void {
    this.transports.push(transport);
    this.plugins.notifyTransport(transport);
  }

  removeTransport(name: string): void {
    this.transports = this.transports.filter((t) => t.name !== name);
  }

  /** Unregister a plugin by name at runtime. */
  unregisterPlugin(name: string): void {
    this.plugins.unregister(name);
  }

  /** Whether a plugin with the given name is currently registered. */
  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  /** Access the processing pipeline to add/remove filters & processors or change the formatter at runtime. */
  getPipeline(): Pipeline {
    return this.pipeline;
  }

  /** Build the {@link PluginContext} handed to plugins so they can reconfigure the logger. */
  private buildPluginContext(): PluginContext {
    return {
      addTransport: (t) => this.addTransport(t),
      removeTransport: (n) => this.removeTransport(n),
      pipeline: this.pipeline,
      use: (p) => this.use(p),
      unregisterPlugin: (n) => this.unregisterPlugin(n),
      logger: this,
    };
  }

  getTransports(): readonly Transport[] {
    return this.transports;
  }

  // ---- Plugins ----

  use(plugin: Plugin): Promise<void> {
    return this.plugins.register(plugin);
  }

  // ---- Scoped loggers ----

  /**
   * Derive a scoped child logger. The new logger shares this one's transports,
   * pipeline and plugins, but carries its own scope (joined with the parent's
   * via `:`) and an isolated context store.
   */
  scope(scope: string, context?: Record<string, unknown>): Logger {
    const childScope = this.scopeName ? `${this.scopeName}:${scope}` : scope;
    const childContext = this.context.child();
    if (context) {
      childContext.merge(context);
    }
    const child = new Logger({
      level: this.level,
      scope: childScope,
      runtime: this.runtime,
      context: childContext,
      transports: this.transports,
      pipeline: this.pipeline,
      plugins: this.plugins,
    });
    return child;
  }

  // ---- Emitting ----

  trace: LogFn = (message, ...args) => this.emit('trace', message, args);
  debug: LogFn = (message, ...args) => this.emit('debug', message, args);
  info: LogFn = (message, ...args) => this.emit('info', message, args);
  warn: LogFn = (message, ...args) => this.emit('warn', message, args);
  error: LogFn = (message, ...args) => this.emit('error', message, args);
  fatal: LogFn = (message, ...args) => this.emit('fatal', message, args);

  private emit(levelName: LogLevelName, message: unknown, args: unknown[]): void {
    if (this.destroyed) return;
    const levelValue = LOG_LEVELS[levelName];
    if (levelValue < this.level) return;

    const entry = this.buildEntry(levelName, levelValue, message, args);
    const processed = this.pipeline.process(entry);
    if (!processed) return;

    this.dispatch(processed);
  }

  /**
   * Route a processed entry to the transports. When no plugin intercepts
   * entries we can write synchronously and skip the per-call Promise + write
   * queue entirely (the common case); the async path is only used when a plugin
   * hook or an async transport needs it.
   */
  private dispatch(entry: LogEntry): void {
    if (this.plugins.hasEntryInterceptors()) {
      const p = this.plugins.intercept(entry).then((intercepted) => {
        if (intercepted) this.writeToTransports(intercepted);
      });
      this.writeQueue = this.writeQueue
        .then(() => p)
        .catch(() => {
          /* never reject the queue */
        });
      return;
    }
    this.writeToTransports(entry);
  }

  private buildEntry(
    levelName: LogLevelName,
    levelValue: number,
    message: unknown,
    args: unknown[],
  ): LogEntry {
    let msg: string;
    let error: Error | undefined;
    let rest = args;

    if (message instanceof Error) {
      error = message;
      msg = message.message;
    } else if (typeof message === 'string') {
      msg = message;
    } else {
      // Non-string / non-Error first argument (e.g. an object): preserve it as
      // structured data instead of coercing to "[object Object]".
      msg = '';
      rest = [message, ...args];
    }

    if (!error) {
      error = rest.find((a) => a instanceof Error) as Error | undefined;
    }

    const now = this.runtime.now();
    const ts = typeof now === 'number' ? now : new Date(now).getTime();
    return {
      level: levelValue,
      levelName,
      message: msg,
      args: rest,
      timestamp: ts,
      time: isoFromMs(ts),
      scope: this.scopeName,
      pid: this.runtime.pid(),
      context: this.context.get(),
      metadata: {},
      error,
    };
  }

  private writeToTransports(entry: LogEntry): void {
    for (const transport of this.transports) {
      const formatter: Formatter = transport.formatter ?? this.pipeline.getFormatter();
      let formatted: unknown;
      try {
        formatted = formatter(entry);
      } catch (err) {
        console.error('[lograil] formatter failed:', err);
        formatted = `[formatting failed] ${entry.message}`;
      }
      const result = transport.write(entry, String(formatted));
      if (result && typeof (result as Promise<void>).then === 'function') {
        this.writeQueue = this.writeQueue
          .then(() => result as Promise<void>)
          .catch(() => {
            /* never reject the queue */
          });
      }
    }
  }

  // ---- Lifecycle ----

  async flush(): Promise<void> {
    await this.writeQueue;
    for (const transport of this.transports) {
      if (transport.flush) {
        await transport.flush();
      }
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    await this.flush();
    await this.plugins.destroy();
    this.detachReceiver?.();
    for (const transport of this.transports) {
      if (transport.close) {
        await transport.close();
      }
    }
  }
}
