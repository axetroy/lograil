import type { LogEntry, LogFn, LoggerMethods, LogLevelInput, LogLevelName } from '../types.js';
import { LOG_LEVELS, normalizeLevel, isLogLevelName } from '../types.js';
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
import { createContextStore, asyncContext, isEmptyRecord, EMPTY_RECORD } from '../context/index.js';
import { freezeEntry } from './entry.js';
import { formatMessage, hasPrintfSpecifier } from './printf.js';

// Captured at module load — before `redirectConsole` can replace `console.*` —
// so the logger's own error reporting never recurses into itself.
const RAW_CONSOLE_ERROR: (...args: unknown[]) => void =
  typeof console !== 'undefined' && typeof console.error === 'function'
    ? console.error.bind(console)
    : () => {};

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

/** Where in the pipeline an internal error originated. */
export type LoggerErrorPhase = 'filter' | 'process' | 'plugin' | 'formatter' | 'transport';

/** Context passed to {@link LoggerErrorHandler} when the logger catches an internal error. */
export interface LoggerErrorInfo {
  phase: LoggerErrorPhase;
  /** The entry being processed when the error occurred, if available. */
  entry?: LogEntry;
  /** Name of the offending plugin/transport, when applicable. */
  source?: string;
}

/**
 * Global error handler. The logger never throws from a `log.*` call; when an
 * internal step (filter, processor, plugin, formatter, transport) fails, the
 * error is reported here instead of crashing the caller. By default it is
 * printed to the native `console.error` (which is *not* the redirected one, so
 * it cannot recurse into the logger).
 */
export type LoggerErrorHandler = (error: unknown, info: LoggerErrorInfo) => void;

// ---- Namespace (scope) filtering ----

interface NamespacePattern {
  re: RegExp;
}

interface NamespaceFilter {
  includes: NamespacePattern[];
  excludes: NamespacePattern[];
}

/** Cache compiled namespace filters by normalized input to avoid recompiling regexes on every call. */
const nsFilterCache = new Map<string, NamespaceFilter | undefined>();

function serializeNsInput(input?: string | string[]): string {
  if (!input) return '';
  if (Array.isArray(input)) return input.join(',');
  return input;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toPattern(token: string): NamespacePattern {
  const body = token
    .split('*')
    .map((part) => escapeRegex(part))
    .join('.*');
  return { re: new RegExp(`^${body}$`) };
}

/**
 * Compile a namespace filter. `input` is a comma/space-separated list of glob
 * patterns (with `*` wildcards); a leading `-` excludes. An empty input yields
 * `undefined` (no filtering).
 */
function compileNamespaceFilter(input?: string | string[]): NamespaceFilter | undefined {
  const key = serializeNsInput(input);
  if (nsFilterCache.has(key)) return nsFilterCache.get(key);
  let result: NamespaceFilter | undefined;
  if (!input || (Array.isArray(input) && input.length === 0)) {
    result = undefined;
  } else {
    const tokens = (Array.isArray(input) ? input : input.split(/[ ,]+/))
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) {
      result = undefined;
    } else {
      const includes: NamespacePattern[] = [];
      const excludes: NamespacePattern[] = [];
      for (const token of tokens) {
        if (token.startsWith('-')) excludes.push(toPattern(token.slice(1)));
        else includes.push(toPattern(token));
      }
      result = { includes, excludes };
    }
  }
  nsFilterCache.set(key, result);
  return result;
}

function matchesNamespace(scope: string | undefined, filter: NamespaceFilter | undefined): boolean {
  if (!filter) return true;
  const s = scope ?? '';
  for (const ex of filter.excludes) {
    if (ex.re.test(s)) return false;
  }
  if (filter.includes.length === 0) return true;
  return filter.includes.some((inc) => inc.re.test(s));
}

/** Read an environment variable, returning `undefined` when unavailable/empty. */
function readEnvVar(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  const v = process.env[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export interface LoggerOptions {
  /** Minimum level to emit. Default `info`. */
  level?: LogLevelInput;
  /**
   * Global handler for internal errors (a throwing filter/processor/plugin, a
   * failing formatter, or a broken transport). When omitted, errors are printed
   * to the native `console.error`. The logger never rethrows them.
   */
  onError?: LoggerErrorHandler;
  /**
   * Maximum time (ms) to wait for an async `Transport.write` before treating it
   * as failed (reported via the transport's `onError` / the global handler), so
   * a stalled sink can never hang `flush()`/`destroy()`. Default `5000`.
   */
  writeTimeoutMs?: number;
  /**
   * Maximum time (ms) to spend flushing on process exit (`beforeExit`,
   * `SIGINT`, `SIGTERM`) before giving up and letting the process exit, so a
   * stalled transport flush can never hang shutdown. Default `2000`.\
   */
  flushTimeoutMs?: number;
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
  /**
   * Environment variable (name) whose value, if set to a valid level name,
   * overrides `level`. Defaults to `"LOG_LEVEL"`. Set to `null` to disable.
   */
  levelEnvVar?: string | null;
  /**
   * Scope filter. A comma- or space-separated list of glob patterns
   * (with `*` wildcards); a leading `-` excludes. Only entries whose `scope`
   * matches are emitted. Read automatically from `scopeFilterEnvVar` when omitted.
   */
  scopeFilter?: string | string[];
  /**
   * Environment variable whose value supplies the scope filter when
   * `scopeFilter` is not set. Defaults to `"LOGRAIL_DEBUG"`. Set to `null`
   * to disable.
   */
  scopeFilterEnvVar?: string | null;
}

/**
 * Internal options passed by `scope`/`child` to build a **lightweight** child
 * logger. The child reuses the parent's runtime, pipeline, plugins, transports
 * and namespace filter — it only carries its own scope and context. This avoids
 * re-running environment reads, regex compilation and runtime detection on
 * every derived logger (important for per-request `child({ requestId })`).
 */
interface ChildOptions {
  __child: true;
  parent: Logger;
  scope?: string;
  context?: ContextStore;
  levelOverride?: number;
}

/** Narrowing guard for {@link ChildOptions}. */
function isChildOptions(o: LoggerOptions | ChildOptions): o is ChildOptions {
  return (o as ChildOptions).__child === true;
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
 * Instances are cheap to derive via {@link scope} or {@link child}; all
 * children share the same transports, pipeline and plugins, but carry their own
 * scope and context (captured from the parent at creation).
 */
export class Logger implements LoggerMethods {
  private runtime!: RuntimeAdapter;
  private pipeline!: Pipeline;
  private plugins!: PluginManager;
  private transports!: Transport[];
  private context!: ContextStore;
  private level!: number;
  private scopeName?: string;
  private parent?: Logger;
  private levelOverride?: number;
  /**
   * Bounded async queue for plugin interception. Tracks in-flight entries so
   * `flush()` and `destroy()` know when all interceptions are done without
   * letting the dispatch chain grow unboundedly (each push would append a
   * `.then()` to an ever-longer Promise chain).
   */
  private dispatchInflight = 0;
  private dispatchDrain: Promise<void> | null = null;
  private dispatchDrainResolve: (() => void) | undefined = undefined;
  /** Independent async-write queue per transport. */
  private transportQueues = new Map<Transport, Promise<void>>();
  private destroyed = false;
  private detachReceiver?: () => void;
  private processHandlersAttached = false;
  private errorHandlersAttached = false;
  private removeProcessHandlers?: () => void;
  private onLoggerError?: LoggerErrorHandler;
  private writeTimeoutMs!: number;
  private flushTimeoutMs!: number;
  private _exiting = false;
  private scopeFilter?: NamespaceFilter;
  /** True for loggers created via `scope`/`child` (share the parent's plumbing). */
  private isChild = false;
  /** Cached peer process level. When set, takes precedence over local `level` in `getLevel()`. */
  private peerLevel?: number;
  /** Original local level before any peer command modifies it. Restored on destroy. */
  private originalLevel?: number;
  /** Tracks whether the local level was explicitly set via setLevel(). */
  private hasExplicitLocalLevel = false;

  constructor(options: LoggerOptions | ChildOptions = {}) {
    // Lightweight child path: reuse the parent's runtime, pipeline, plugins,
    // transports and namespace filter, skipping env reads, regex compilation
    // and runtime detection entirely. This keeps `scope`/`child` (used per
    // request, e.g. `logger.child({ requestId })`) near-zero allocation.
    if (isChildOptions(options)) {
      this.isChild = true;
      this.initFromParent(options);
      return;
    }
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
    const envLevelName =
      options.levelEnvVar === null ? undefined : readEnvVar(options.levelEnvVar ?? 'LOG_LEVEL');
    const levelInput: LogLevelInput =
      envLevelName && isLogLevelName(envLevelName) ? envLevelName : (options.level ?? 'info');
    this.level = normalizeLevel(levelInput);
    this.originalLevel = this.level;
    this.scopeName = options.scope;

    const nsInput =
      options.scopeFilter ??
      (options.scopeFilterEnvVar === null
        ? undefined
        : readEnvVar(options.scopeFilterEnvVar ?? 'LOGRAIL_DEBUG'));
    this.scopeFilter = compileNamespaceFilter(nsInput);

    // On the Electron main process, receive renderer logs over IPC.
    if (this.runtime.attachReceiver) {
      this.detachReceiver = this.runtime.attachReceiver((entry: LogEntry) =>
        this.ingestEntry(entry),
      );
      this.runtime.onLevelCommand = (level) => {
        this.peerLevel = level;
      };
    }

    if (options.autoFlushOnExit) this.attachExitHandlers();

    this.onLoggerError = options.onError;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 5000;
    this.flushTimeoutMs = options.flushTimeoutMs ?? 2000;
    // Wire the pipeline/plugin error sinks into the unified handler.
    this.pipeline.onError = (err, info) => this.reportError(info.phase, err, info.entry);
    this.plugins.onError = (name, err, entry) => this.reportError('plugin', err, entry, name);
  }

  /**
   * Initialise a lightweight child from its parent. Reuses the parent's
   * runtime, pipeline, plugins, transports and namespace filter, and shares the
   * parent's error handler config so no duplicate `onError` wiring (or duplicate
   * IPC receiver registration) happens.
   */
  private initFromParent(opts: ChildOptions): void {
    const parent = opts.parent;
    this.parent = parent;
    this.runtime = parent.runtime;
    this.pipeline = parent.pipeline;
    this.plugins = parent.plugins;
    this.transports = parent.transports;
    this.scopeFilter = parent.scopeFilter;
    this.context = opts.context ?? createContextStore();
    this.scopeName = opts.scope;
    // Only a root logger owns the shared plugin error sink; children inherit it.
    this.onLoggerError = parent.onLoggerError;
    this.writeTimeoutMs = parent.writeTimeoutMs;
    this.flushTimeoutMs = parent.flushTimeoutMs;
    if (opts.levelOverride !== undefined) this.levelOverride = opts.levelOverride;
  }

  /**
   * Feed an externally produced {@link LogEntry} (e.g. received from a renderer
   * process over IPC) into the pipeline/transports. Subject to the configured
   * level and plugins, then written via the active transports.
   */
  ingestEntry(entry: LogEntry): void {
    if (this.destroyed) return;
    if (entry.level < this.getLevel()) return;
    if (!matchesNamespace(entry.scope, this.scopeFilter)) return;
    this.dispatch(entry);
  }

  // ---- Level ----

  getLevel(): number {
    if (this.levelOverride !== undefined) return this.levelOverride;
    if (this.parent) return this.parent.getLevel();
    // If local level was explicitly set (via constructor or setLevel), use it.
    // Otherwise fall back to the cached peer level.
    if (this.hasExplicitLocalLevel) return this.level;
    if (this.peerLevel !== undefined) return this.peerLevel;
    return this.level;
  }

  setLevel(level: LogLevelInput): void {
    const v = normalizeLevel(level);
    if (this.parent) {
      this.levelOverride = v;
    } else {
      this.level = v;
      this.hasExplicitLocalLevel = true;
    }
  }

  /**
   * Register a callback invoked when a cross-process level command is received
   * (e.g. from a renderer, worker, or cluster peer). Called automatically by
   * the runtime when {@link RuntimeAdapter.onLevelCommand} is wired up; most
   * users should not call this directly.
   */
  setOnLevelCommand(cb: (level: number) => void): void {
    this.runtime.onLevelCommand = cb;
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
    const removed = this.transports.filter((t) => t.name === name);
    this.transports = this.transports.filter((t) => t.name !== name);
    for (const transport of removed) {
      const prev = this.transportQueues.get(transport) ?? Promise.resolve();
      const teardown = prev
        .then(async () => {
          if (transport.flush) await this.guardFlush(transport.flush.bind(transport));
          if (transport.close) await Promise.resolve(transport.close());
        })
        .catch((err) => this.reportError('transport', err, undefined, transport.name))
        .finally(() => {
          this.transportQueues.delete(transport);
        });
      this.transportQueues.set(transport, teardown);
    }
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
   * Derive a scoped child logger. The child shares this logger's transports,
   * pipeline, plugins and runtime, inherits its scope (joined with `:`) and
   * context (captured from the parent at creation), and may carry extra
   * context. The level is inherited live from the parent (see {@link child})
   * unless overridden via `setLevel`.
   *
   * Construction is lightweight: no environment reads, regex compilation or
   * runtime detection is performed — the child reuses this logger's plumbing.
   */
  scope(scope: string, context?: Record<string, unknown>): Logger {
    const childScope = this.scopeName ? `${this.scopeName}:${scope}` : scope;
    const childContext = this.context.child();
    if (context) {
      childContext.merge(context);
    }
    return new Logger({
      __child: true,
      parent: this,
      scope: childScope,
      context: childContext,
    });
  }

  /**
   * Derive a child logger that shares this logger's transports, pipeline,
   * plugins and runtime. The child:
   * - merges `options.context` on top of the parent's context (captured at
   *   creation),
   * - inherits the parent's scope,
   * - inherits the parent's level live, unless `options.level` overrides it
   *   (the override also applies to any further descendants).
   *
   * This is the canonical "child logger" (à la `pino.child`), ideal for
   * per-request context such as `logger.child({ requestId: id })`. Construction
   * is lightweight — see {@link scope}.
   */
  child(options: { context?: Record<string, unknown>; level?: LogLevelInput } = {}): Logger {
    const childContext = this.context.child();
    if (options.context) {
      childContext.merge(options.context);
    }
    return new Logger({
      __child: true,
      parent: this,
      scope: this.scopeName,
      context: childContext,
      levelOverride: options.level !== undefined ? normalizeLevel(options.level) : undefined,
    });
  }

  // ---- Emitting ----

  trace: LogFn = (message, ...args) => this.emit('trace', message, args);
  debug: LogFn = (message, ...args) => this.emit('debug', message, args);
  info: LogFn = (message, ...args) => this.emit('info', message, args);
  /** Alias for {@link info}. */
  log: LogFn = (message, ...args) => this.emit('info', message, args);
  warn: LogFn = (message, ...args) => this.emit('warn', message, args);
  error: LogFn = (message, ...args) => this.emit('error', message, args);
  fatal: LogFn = (message, ...args) => this.emit('fatal', message, args);

  private emit(levelName: LogLevelName, message: unknown, args: unknown[]): void {
    if (this.destroyed) return;
    const levelValue = LOG_LEVELS[levelName];
    if (levelValue < this.getLevel()) return;
    if (!matchesNamespace(this.scopeName, this.scopeFilter)) return;

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
      // Create or reset the drain promise eagerly so that `flush()` callers
      // always have a non-null promise to await, even if they arrive before
      // the current batch of in-flight interceptions completes.
      this.dispatchDrain = new Promise<void>((resolve) => {
        this.dispatchDrainResolve = resolve;
      });
      this.dispatchInflight++;
      this.plugins
        .intercept(entry)
        .then((intercepted) => {
          if (intercepted) this.writeToTransports(intercepted);
        })
        .catch((err) => this.reportError('plugin', err))
        .finally(() => {
          this.dispatchInflight--;
          if (this.dispatchInflight === 0) {
            const resolve = this.dispatchDrainResolve;
            this.dispatchDrain = null;
            this.dispatchDrainResolve = undefined;
            resolve?.();
          }
        });
      return;
    }
    this.writeToTransports(entry);
  }

  /**
   * Report an internal error without throwing. Routes to the user-supplied
   * `onError` handler, falling back to the native `console.error` (deliberately
   * not the redirected one, to avoid recursion).
   */
  private reportError(
    phase: LoggerErrorPhase,
    err: unknown,
    entry?: LogEntry,
    source?: string,
  ): void {
    if (this.onLoggerError) {
      this.onLoggerError(err, { phase, entry, source });
      return;
    }
    RAW_CONSOLE_ERROR(`[lograil]${source ? ` (${source})` : ''} ${phase} error:`, err);
  }

  private buildEntry(
    levelName: LogLevelName,
    levelValue: number,
    message: unknown,
    args: unknown[],
  ): LogEntry {
    let msg: string;
    let error: unknown;
    let rest = args;

    if (message instanceof Error) {
      error = message;
      msg = message.message;
    } else if (typeof message === 'string') {
      // `printf`-style: `logger.info('user %s', name)`. Only enter the format
      // path when at least one argument is present and a legal specifier
      // exists, so the dominant `info('msg', {obj})` pattern stays on the
      // zero-format fast path and literal `%` in messages is preserved.
      if (args.length > 0 && hasPrintfSpecifier(message)) {
        const [formatted, ...restArgs] = formatMessage(message, args);
        msg = formatted;
        rest = restArgs;
      } else {
        msg = message;
      }
    } else {
      // Non-string / non-Error first argument (e.g. an object): preserve it as
      // structured data instead of coercing to "[object Object]".
      msg = '';
      rest = [message, ...args];
    }

    if (!error) {
      error =
        rest.find((a) => a instanceof Error) ??
        rest.find((a) => typeof a === 'string' && a.length > 0);
    }

    const now = this.runtime.now();
    const ts = typeof now === 'number' ? now : new Date(now).getTime();

    // Merge the ambient (request-scoped) context on top of this logger's own
    // context. Reading it is O(1); we only clone when one side is non-empty.
    const base = this.context.get();
    const ambient = asyncContext.get();
    // NB: never hand the live AsyncLocalStorage store directly to the entry —
    // the ambient object is shared across the async scope, so a later mutation
    // (or `freezeEntry` below) would corrupt every entry in that scope. When
    // ambient is the only source we clone it into a per-entry object; otherwise
    // we reuse the frozen EMPTY_RECORD sentinel so the hot path allocates
    // nothing.
    const context =
      ambient === EMPTY_RECORD
        ? base
        : isEmptyRecord(base)
          ? { ...ambient }
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
      // Shared frozen empty record (no per-call allocation); `freezeEntry`
      // recognises it as a sentinel and skips cloning/freezing.
      metadata: EMPTY_RECORD,
      error,
    };
  }

  private writeToTransports(entry: LogEntry): void {
    // Freeze at the single fan-out choke point so every transport, formatter and
    // plugin reads an immutable entry and can safely share it by reference
    // (zero-copy within the process). Idempotent.
    const frozen = freezeEntry(entry);
    for (const transport of this.transports) {
      const tl = transport.level;
      if (tl !== undefined && frozen.level < normalizeLevel(tl)) continue;
      const formatter: Formatter = transport.formatter ?? this.pipeline.getFormatter();
      let formatted: unknown;
      try {
        formatted = formatter(frozen);
      } catch (err) {
        this.reportError('formatter', err, frozen);
        formatted = `[formatting failed] ${frozen.message}`;
      }
      const onErr = transport.onError;
      try {
        const result = transport.write(frozen, String(formatted));
        if (result && typeof (result as Promise<void>).then === 'function') {
          const guarded = this.guardWrite(result as Promise<void>);
          // Chain onto THIS transport's own queue, not a shared one, so a stalled
          // write here cannot block other transports (or the front dispatch queue).
          const prev = this.transportQueues.get(transport) ?? Promise.resolve();
          const next = prev
            .then(() => guarded)
            .catch((err) => this.reportTransportError(err, frozen, onErr));
          this.transportQueues.set(transport, next);
        }
      } catch (err) {
        this.reportTransportError(err, frozen, onErr);
      }
    }
  }

  /** Await a transport's async `write`, but never let it stall the queue. */
  private guardWrite(p: Promise<void>): Promise<void> {
    if (!this.writeTimeoutMs) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`transport write timed out after ${this.writeTimeoutMs}ms`)),
        this.writeTimeoutMs,
      );
    });
    return Promise.race([p, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** Await a transport's async `flush`, but never let it stall teardown. */
  private guardFlush(p: () => void | Promise<void>): Promise<void> {
    if (!this.flushTimeoutMs) return Promise.resolve();
    const result = p();
    if (!result || typeof (result as Promise<void>).then !== 'function') return Promise.resolve();
    return this.guardWrite(result as Promise<void>);
  }

  /** Surface a transport failure via the transport's hook, else the global handler. */
  private reportTransportError(
    err: unknown,
    entry: LogEntry,
    onErr?: (err: unknown, entry: LogEntry) => void,
  ): void {
    if (onErr) onErr(err, entry);
    else this.reportError('transport', err, entry);
  }

  // ---- Lifecycle ----

  async flush(): Promise<void> {
    // Let in-flight interception finish so every scheduled write has been
    // enqueued onto its transport's own queue.
    if (this.dispatchInflight > 0) await this.dispatchDrain;
    // Aggregate all per-transport async-write queues. `allSettled` means a
    // rejected/errored transport queue never rejects flush; a stalled one is
    // bounded by `writeTimeoutMs` via `guardWrite`.
    await Promise.allSettled(Array.from(this.transportQueues.values()));
    // Flush each transport's internal buffers with the same timeout guard so
    // a stalled flush can never hang shutdown or caller code.
    await Promise.allSettled(
      this.transports.map((t) => (t.flush ? this.guardFlush(t.flush.bind(t)) : Promise.resolve())),
    );
  }

  /**
   * Flush, but never wait longer than `ms`. Resolves (does not reject) once the
   * flush settles or the timeout elapses, so callers can always proceed (e.g.
   * exit the process) without risking a hang on a stalled transport.
   */
  private flushWithTimeout(ms: number): Promise<void> {
    if (!ms) return this.flush();
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(done, ms);
      if (typeof timer.unref === 'function') timer.unref();
      this.flush().then(done, done);
    });
  }

  /** Set the max time (ms) to flush before process exit before giving up. */
  setExitFlushTimeout(ms: number): this {
    if (Number.isFinite(ms) && ms >= 0) this.flushTimeoutMs = ms;
    return this;
  }

  /** Get the current exit-flush timeout (ms). */
  getExitFlushTimeout(): number {
    return this.flushTimeoutMs;
  }

  // ---- Process integration ----

  /**
   * Register `beforeExit` / `SIGINT` / `SIGTERM` handlers that flush the logger
   * before the process leaves. On `SIGINT` / `SIGTERM` the process exits (130 /
   * 143) after the flush completes. No-op outside Node. Idempotent.
   */
  attachExitHandlers(): void {
    if (this.processHandlersAttached) return;
    // Prefer runtime-provided lifecycle hooks so the logger stays
    // runtime-agnostic and the runtime owns process/window event wiring and
    // exit semantics. Falls back to a direct `process` binding below for
    // adapters that don't supply lifecycle hooks (e.g. custom test runtimes).
    const lc = this.runtime.lifecycle;
    if (lc) {
      const ms = this.flushTimeoutMs;
      const detach = lc.onFlushBeforeExit(() => {
        void this.flushWithTimeout(ms);
      });
      const prev = this.removeProcessHandlers;
      this.removeProcessHandlers = () => {
        prev?.();
        detach();
      };
      this.processHandlersAttached = true;
      return;
    }
    const proc = getNodeProcess();
    if (!proc) return;
    const ms = this.flushTimeoutMs;
    // On normal exit the event loop is about to empty: flush pending writes.
    // `beforeExit` re-fires as long as async writes keep the loop alive, so the
    // queue keeps draining until empty (bounded by `ms` if a sink stalls).
    const onBeforeExit = (): void => {
      void this.flushWithTimeout(ms);
    };
    // On a signal, flush what we can, then terminate — but never hang shutdown
    // on a stalled transport (the timeout guarantees we still exit).
    const onSignal = (code: number): void => {
      if (this._exiting) return;
      this._exiting = true;
      void this.flushWithTimeout(ms).finally(() => {
        try {
          proc.exit(code);
        } catch {
          /* ignore */
        }
      });
    };
    const onSigInt = (): void => onSignal(130);
    const onSigTerm = (): void => onSignal(143);
    proc.on('beforeExit', onBeforeExit);
    proc.on('SIGINT', onSigInt);
    proc.on('SIGTERM', onSigTerm);
    // Windows does not emit `SIGTERM`. Register `SIGBREAK` (Ctrl+Break) as a
    // best-effort fallback so `autoFlushOnExit` has a signal hook on that
    // platform. In practice taskkill / OS shutdown kills without emitting any
    // Node signal, so no handler can cover that path — the `beforeExit` hook
    // is the only portable shutdown flush mechanism.
    if (process.platform === 'win32') {
      proc.on('SIGBREAK', onSigInt);
    }
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
    // Delegate to the runtime's lifecycle hooks when present (see
    // `attachExitHandlers` for the rationale). The hooks own the `process`
    // events and the post-flush `exit(1)`; we only provide the fatal log +
    // bounded flush. Runtimes without an `onUncaughtError` hook (e.g. web)
    // fall back to the direct `process` binding below, which is a no-op there.
    const lc = this.runtime.lifecycle;
    if (lc?.onUncaughtError) {
      const ms = this.flushTimeoutMs;
      const detach = lc.onUncaughtError((err: unknown) => {
        this.fatal(err);
        return this.flushWithTimeout(ms);
      });
      const prev = this.removeProcessHandlers;
      this.removeProcessHandlers = () => {
        prev?.();
        detach();
      };
      this.errorHandlersAttached = true;
      return;
    }
    const proc = getNodeProcess();
    if (!proc) return;
    const onUncaught = (err: unknown): void => {
      this.fatal(err);
      void this.flushWithTimeout(this.flushTimeoutMs).finally(() => proc.exit(1));
    };
    const onRejection = (reason: unknown): void => {
      this.fatal(reason);
      void this.flushWithTimeout(this.flushTimeoutMs).finally(() => proc.exit(1));
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
    // Only a root logger owns the shared resources (process handlers, plugins,
    // transports, the IPC receiver). A child shares them with its parent and
    // must not tear them down — destroying a child used to silently break the
    // parent's transports and plugins.
    if (this.isChild) {
      this.transportQueues.clear();
      return;
    }
    this.removeProcessHandlers?.();
    // Flush pending writes before tearing down transports, so buffered logs
    // are not lost. Bounded by the exit-flush timeout so a stalled sink can
    // never hang teardown.
    await this.flushWithTimeout(this.flushTimeoutMs).catch(() => {});
    await this.plugins.destroy().catch(() => {});
    this.detachReceiver?.();
    this.peerLevel = undefined;
    if (this.originalLevel !== undefined) {
      this.level = this.originalLevel;
      this.hasExplicitLocalLevel = false;
    }
    for (const transport of this.transports) {
      if (transport.close) {
        await Promise.resolve(transport.close()).catch(() => {});
      }
    }
    this.transportQueues.clear();
    this.dispatchInflight = 0;
    this.dispatchDrain = null;
    this.dispatchDrainResolve = undefined;
  }
}
