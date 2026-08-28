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
import { createContextStore, asyncContext, isEmptyRecord } from '../context/index.js';

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
  /**
   * Register `beforeExit` / `SIGINT` / `SIGTERM` handlers that flush the logger
   * before the process exits (`SIGINT`/`SIGTERM` then terminate the process).
   * Only effective in Node; ignored elsewhere. See {@link attachExitHandlers}.
   */
  autoFlushOnExit?: boolean;
}

/** Minimal structural view of the Node `process` used for lifecycle hooks. */
type NodeProcess = {
  on(event: string, cb: (...args: unknown[]) => void): void;
  once(event: string, cb: (...args: unknown[]) => void): void;
  removeListener(event: string, cb: (...args: unknown[]) => void): void;
  exit(code: number): void;
};

function getNodeProcess(): NodeProcess | undefined {
  if (typeof process === 'undefined' || typeof (process as { on?: unknown }).on !== 'function') {
    return undefined;
  }
  return process as unknown as NodeProcess;
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
  private processHandlersAttached = false;
  private errorHandlersAttached = false;
  private removeProcessHandlers?: () => void;

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

    if (options.autoFlushOnExit) this.attachExitHandlers();
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

    // Merge the ambient (request-scoped) context on top of this logger's own
    // context. Reading it is O(1); we only clone when one side is non-empty.
    const base = this.context.get();
    const ambient = asyncContext.get();
    const context = isEmptyRecord(ambient)
      ? base
      : isEmptyRecord(base)
        ? ambient
        : { ...base, ...ambient };

    return {
      level: levelValue,
      levelName,
      message: msg,
      args: rest,
      timestamp: ts,
      time: isoFromMs(ts),
      scope: this.scopeName,
      pid: this.runtime.pid(),
      context,
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

  // ---- Process integration ----

  /**
   * Register `beforeExit` / `SIGINT` / `SIGTERM` handlers that flush the logger
   * before the process leaves. On `SIGINT` / `SIGTERM` the process exits (130 /
   * 143) after the flush completes. No-op outside Node. Idempotent.
   */
  attachExitHandlers(): void {
    if (this.processHandlersAttached) return;
    const proc = getNodeProcess();
    if (!proc) return;
    const onBeforeExit = (): void => {
      void this.flush();
    };
    const onSignal = (code: number): void => {
      void this.flush().finally(() => proc.exit(code));
    };
    const onSigInt = (): void => onSignal(130);
    const onSigTerm = (): void => onSignal(143);
    proc.on('beforeExit', onBeforeExit);
    proc.once('SIGINT', onSigInt);
    proc.once('SIGTERM', onSigTerm);
    this.processHandlersAttached = true;
    const prev = this.removeProcessHandlers;
    this.removeProcessHandlers = () => {
      prev?.();
      proc.removeListener('beforeExit', onBeforeExit);
      proc.removeListener('SIGINT', onSigInt);
      proc.removeListener('SIGTERM', onSigTerm);
    };
  }

  /**
   * Forward `uncaughtException` and `unhandledRejection` to the logger (at
   * `fatal` level) and exit afterwards, so crashes are recorded before the
   * process dies. No-op outside Node. Idempotent.
   */
  watchUncaughtErrors(): void {
    if (this.errorHandlersAttached) return;
    const proc = getNodeProcess();
    if (!proc) return;
    const onUncaught = (err: unknown): void => {
      this.fatal(err);
      void this.flush().finally(() => proc.exit(1));
    };
    const onRejection = (reason: unknown): void => {
      this.fatal(reason);
      void this.flush().finally(() => proc.exit(1));
    };
    proc.on('uncaughtException', onUncaught);
    proc.on('unhandledRejection', onRejection);
    this.errorHandlersAttached = true;
    const prev = this.removeProcessHandlers;
    this.removeProcessHandlers = () => {
      prev?.();
      proc.removeListener('uncaughtException', onUncaught);
      proc.removeListener('unhandledRejection', onRejection);
    };
  }

  /**
   * Route `console.*` calls through this logger, so third-party `console.log`
   * output is captured into the structured pipeline. The native console output
   * is suppressed for those calls (the logger's own transports produce the
   * visible output); if logging throws, the native console is used as a
   * fallback. Returns a function that restores the original `console`.
   */
  redirectConsole(): () => void {
    if (typeof console === 'undefined') return () => {};
    const routes: Array<[keyof Console, 'trace' | 'debug' | 'info' | 'warn' | 'error']> = [
      ['log', 'info'],
      ['info', 'info'],
      ['debug', 'debug'],
      ['warn', 'warn'],
      ['error', 'error'],
      ['trace', 'trace'],
    ];
    const originals: Partial<Record<keyof Console, (...args: unknown[]) => void>> = {};
    for (const [method, level] of routes) {
      const original = (console[method] as ((...args: unknown[]) => void) | undefined)?.bind(
        console,
      );
      if (!original) continue;
      originals[method] = original;
      (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]): void => {
        try {
          (this[level] as (...a: unknown[]) => void)(...args);
        } catch {
          original(...args);
        }
      };
    }
    return () => {
      for (const key of Object.keys(originals) as (keyof Console)[]) {
        (console as unknown as Record<string, unknown>)[key] = originals[key];
      }
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.removeProcessHandlers?.();
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
