import type { LogEntry } from '../types.js';
import type { Transport } from '../transport/transport.js';
import type { Pipeline } from '../pipeline/pipeline.js';
import type { Logger } from '../core/logger.js';

/**
 * A Plugin extends the logger's behavior through lifecycle hooks. All hooks
 * are optional. A plugin that needs to transform entries should implement
 * `onEntry`, returning the (possibly new) entry or `null` to drop it.
 */
export interface Plugin {
  /** Unique plugin name. */
  readonly name: string;
  /** Called once when the plugin is registered (or via `ctx.use`). */
  onInit?(ctx: PluginContext): void | Promise<void>;
  /** Called for every entry before it reaches the pipeline's formatter. */
  onEntry?(entry: LogEntry): LogEntry | null | Promise<LogEntry | null>;
  /** Called when a transport is added (incl. by other plugins). */
  onTransport?(transport: Transport): void;
  /** Called when the plugin is unregistered or the logger is destroyed. */
  onDestroy?(): void | Promise<void>;
}

/**
 * Capabilities handed to a plugin so it can reconfigure the logger at runtime.
 * This is the bridge that lets plugins dynamically add/remove transports,
 * reshape the processing pipeline, and even register/unregister other plugins.
 */
export interface PluginContext {
  /** Add a transport at runtime. */
  addTransport(transport: Transport): void;
  /** Remove a transport by name. */
  removeTransport(name: string): void;
  /** The processing pipeline — add/remove filters & processors, change the formatter. */
  pipeline: Pipeline;
  /** Register another plugin at runtime. */
  use(plugin: Plugin): Promise<void>;
  /** Unregister a plugin by name. */
  unregisterPlugin(name: string): void;
  /** The owning logger (e.g. to call `setLevel`). */
  logger: Logger;
}
