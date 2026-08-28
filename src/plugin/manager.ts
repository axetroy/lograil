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
    await plugin.onInit?.(this.host);
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
   */
  async intercept(entry: LogEntry): Promise<LogEntry | null> {
    let current: LogEntry | null = entry;
    for (const plugin of this.plugins.values()) {
      if (!current) break;
      if (plugin.onEntry) {
        try {
          current = await plugin.onEntry(current);
        } catch (err) {
          this.onError?.(plugin.name, err, entry);
          // Keep the entry as-is; a faulty plugin must not drop or mutate it.
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
