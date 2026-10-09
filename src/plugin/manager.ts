import type { LogEntry } from '../types.js';
import type { Transport } from '../transport/transport.js';
import type { Plugin, PluginContext } from './plugin.js';

/**
 * Manages plugin registration and lifecycle. The logger delegates entry
 * interception and transport registration to this manager.
 */
export class PluginManager {
  private plugins = new Map<string, Plugin>();
  private host: PluginContext;
  /** Count of plugins with an `onEntry` hook; gates the async intercept path. */
  private entryInterceptors = 0;
  /**
   * Error sink for a plugin's `onEntry` hook. A throwing hook must never drop
   * the entry silently or crash logging; the error is reported and the entry
   * proceeds unchanged.
   */
  onError?: (pluginName: string, err: unknown, entry: LogEntry) => void;

  constructor(host: PluginContext) {
    this.host = host;
  }

  async register(plugin: Plugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin already registered: ${plugin.name}`);
    }
    this.plugins.set(plugin.name, plugin);
    if (plugin.onEntry) this.entryInterceptors++;
    try {
      await plugin.onInit?.(this.host);
    } catch (err) {
      if (plugin.onEntry) this.entryInterceptors--;
      this.plugins.delete(plugin.name);
      throw err;
    }
  }

  /** Unregister a plugin by name. Its `onDestroy` hook (if any) is invoked. */
  unregister(name: string): void {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    if (plugin.onEntry) this.entryInterceptors--;
    this.plugins.delete(name);
    void plugin.onDestroy?.();
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /** True when at least one plugin can intercept entries via `onEntry`. */
  hasEntryInterceptors(): boolean {
    return this.entryInterceptors > 0;
  }

  /**
   * Notify plugins that a transport was added (so `onTransport` hooks run).
   * Called by the logger's `addTransport`.
   */
  notifyTransport(transport: Transport): void {
    for (const plugin of this.plugins.values()) {
      plugin.onTransport?.(transport);
    }
  }

  /**
   * Run every plugin's `onEntry` hook in registration order. A plugin may
   * return `null` to drop the entry, or a modified entry to pass downstream.
   *
   * Each hook receives a **shallow copy** of the entry, not the shared
   * frozen original. A plugin that mutates the entry in place and then
   * throws therefore cannot leak its partial mutation to later plugins or to
   * the transports; the next hook still sees the last *returned* value.
   */
  async intercept(entry: LogEntry): Promise<LogEntry | null> {
    let current: LogEntry | null = entry;
    for (const plugin of this.plugins.values()) {
      if (!current) break;
      if (plugin.onEntry) {
        try {
          // Shallow snapshot: the plugin may read freely; if it mutates in
          // place and throws, the mutation stays local to this copy.
          const snapshot: LogEntry = { ...current };
          const result = await plugin.onEntry(snapshot);
          // `null` / `undefined` is an explicit drop signal from the plugin.
          current = result === null || result === undefined ? null : result;
        } catch (err) {
          this.onError?.(plugin.name, err, entry);
          // Keep the last good value; a faulty plugin must not drop or
          // mutate the entry that reaches the transports.
        }
      }
    }
    return current;
  }

  async destroy(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.onDestroy?.();
    }
    this.plugins.clear();
  }
}
