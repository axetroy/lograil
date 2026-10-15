import { describe, it, expect } from 'vitest';
import { Logger } from '../src/core/index.js';
import { Pipeline } from '../src/pipeline/pipeline.js';
import type { LogEntry } from '../src/types.js';
import type { Plugin } from '../src/plugin/index.js';
import { PluginManager } from '../src/plugin/index.js';
import type { Transport } from '../src/transport/transport.js';
import { createLevelFilter, type Filter } from '../src/pipeline/index.js';
import { LOG_LEVELS } from '../src/types.js';

class TagPlugin implements Plugin {
  readonly name = 'tag';
  onEntry(entry: LogEntry): LogEntry {
    return { ...entry, metadata: { ...entry.metadata, tagged: true } };
  }
}

class DropPlugin implements Plugin {
  readonly name = 'drop';
  onEntry(): LogEntry | null {
    return null;
  }
}

class MemoryTransport implements Transport {
  readonly name: string;
  entries: LogEntry[] = [];
  formatted: string[] = [];
  constructor(name = 'memory') {
    this.name = name;
  }
  write(entry: LogEntry, formatted: string): void {
    this.entries.push(entry);
    this.formatted.push(formatted);
  }
}

describe('Plugins', () => {
  it('intercepts and enriches entries', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });
    await logger.use(new TagPlugin());
    logger.info('hi');
    await logger.flush();
    expect(t.entries[0].metadata.tagged).toBe(true);
  });

  it('can drop entries', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });
    await logger.use(new DropPlugin());
    logger.info('bye');
    await logger.flush();
    expect(t.entries).toHaveLength(0);
  });

  it('a plugin that mutates in place and throws does not leak its mutation (P2-9)', async () => {
    // The manager passes a shallow snapshot to onEntry. Even if a plugin
    // mutates the entry it receives AND throws, the next plugin (or the
    // transports) still see the last *returned* value, not the mutation.
    // (When the entry is frozen the mutation is a no-op anyway, but the
    // snapshot contract protects the non-frozen paths too.)
    const seen = { fields: {} as Record<string, unknown> };
    const capture: Plugin = {
      name: 'capture',
      onEntry(entry) {
        seen.fields = { ...entry.metadata };
        return entry;
      },
    };
    const bad: Plugin = {
      name: 'bad',
      onEntry(entry) {
        // Mutate the snapshot in place, then throw.
        entry.metadata = { ...entry.metadata, badField: 'leaked' };
        throw new Error('boom');
      },
    };
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });
    await logger.use(bad);
    await logger.use(capture);
    logger.info('hello');
    await logger.flush();

    // The capture plugin ran AFTER `bad` threw, so it must see the last
    // good value — the original entry without `badField`.
    expect(t.entries).toHaveLength(1);
    expect(seen.fields.badField).toBeUndefined();
  });

  it('rejects duplicate plugin names', async () => {
    const logger = new Logger({ level: 'debug' });
    await logger.use(new TagPlugin());
    await expect(logger.use(new TagPlugin())).rejects.toThrow(/already registered/);
  });

  it('a plugin can add and remove transports at runtime', async () => {
    const main = new MemoryTransport('main');
    const logger = new Logger({ transports: [main], level: 'debug' });
    const toggler: Plugin = {
      name: 'toggler',
      onInit(ctx) {
        ctx.addTransport(new MemoryTransport('extra'));
      },
    };
    await logger.use(toggler);
    expect(logger.getTransports().map((t) => t.name)).toEqual(['main', 'extra']);
    logger.unregisterPlugin('toggler');
    logger.removeTransport('extra');
    expect(logger.getTransports().map((t) => t.name)).toEqual(['main']);
  });
  it('PluginContext can remove transports and unregister sibling plugins', async () => {
    const main = new MemoryTransport('main');
    const extra = new MemoryTransport('extra');
    const logger = new Logger({ transports: [main, extra], level: 'debug' });
    await logger.use(new TagPlugin());
    const rewirer: Plugin = {
      name: 'rewirer',
      onInit(ctx) {
        ctx.removeTransport('extra');
        ctx.unregisterPlugin('tag');
      },
    };
    await logger.use(rewirer);
    expect(logger.getTransports().map((t) => t.name)).toEqual(['main']);
    expect(logger.hasPlugin('tag')).toBe(false);
    expect(logger.hasPlugin('rewirer')).toBe(true);
  });

  it('a plugin can reshape the pipeline (filter + formatter)', async () => {
    const t = new MemoryTransport('mem');
    const logger = new Logger({ transports: [t], level: 'debug' });
    const formatPlugin: Plugin = {
      name: 'format',
      onInit(ctx) {
        ctx.pipeline.addFilter(createLevelFilter(LOG_LEVELS.error));
        ctx.pipeline.setFormatter(() => 'FORMATTED');
      },
    };
    await logger.use(formatPlugin);
    logger.debug('dropped');
    logger.error('kept');
    await logger.flush();
    expect(t.entries.map((e) => e.message)).toEqual(['kept']);
    expect(t.formatted).toEqual(['FORMATTED']);
  });

  it('a plugin can register and unregister other plugins', async () => {
    const logger = new Logger({ transports: [new MemoryTransport()], level: 'debug' });
    let childInited = false;
    const child: Plugin = { name: 'child', onInit: () => void (childInited = true) };
    const parent: Plugin = {
      name: 'parent',
      onInit(ctx) {
        return ctx.use(child);
      },
    };
    await logger.use(parent);
    expect(childInited).toBe(true);
    expect(logger.hasPlugin('child')).toBe(true);
    logger.unregisterPlugin('child');
    expect(logger.hasPlugin('child')).toBe(false);
  });

  it('Logger exposes runtime reconfiguration of pipeline/transports/plugins', async () => {
    const t = new MemoryTransport('mem');
    const logger = new Logger({ transports: [t], level: 'debug' });
    const extra = new MemoryTransport('extra');
    logger.addTransport(extra);
    expect(logger.getTransports().map((x) => x.name)).toEqual(['mem', 'extra']);

    const dropAll: Filter = () => false;
    logger.getPipeline().addFilter(dropAll);
    logger.info('x');
    await logger.flush();
    expect(t.entries).toHaveLength(0);
    logger.getPipeline().removeFilter(dropAll);
    logger.info('y');
    await logger.flush();
    expect(t.entries.map((e) => e.message)).toEqual(['y']);

    logger.unregisterPlugin('nonexistent'); // must not throw
  });
});

describe('PluginManager - lifecycle hooks', () => {
  function host(): PluginManager {
    return new PluginManager({
      addTransport: () => {},
      removeTransport: () => {},
      pipeline: new Pipeline(),
      use: async () => {},
      unregisterPlugin: () => {},
      logger: {} as Logger,
    });
  }

  it('invokes onDestroy when a plugin is unregistered', async () => {
    const manager = host();
    let destroyed = 0;
    await manager.register({ name: 'p', onDestroy: () => void destroyed++ });
    manager.unregister('p');
    expect(destroyed).toBe(1);
    expect(manager.has('p')).toBe(false);
  });

  it('stops calling onEntry once a plugin returns null (entry dropped)', async () => {
    const manager = host();
    const calls: string[] = [];
    await manager.register({ name: 'dropper', onEntry: () => null });
    await manager.register({
      name: 'after',
      onEntry: (e) => {
        calls.push('after');
        return e;
      },
    });
    const result = await manager.intercept({} as LogEntry);
    expect(result).toBeNull();
    expect(calls).not.toContain('after');
  });

  it('rolls back registration when onInit throws', async () => {
    const manager = host();
    const boom = new Error('init failed');
    await expect(
      manager.register({
        name: 'broken',
        onEntry: (e) => e,
        onInit: () => {
          throw boom;
        },
      }),
    ).rejects.toThrow('init failed');
    expect(manager.has('broken')).toBe(false);
    expect(manager.hasEntryInterceptors()).toBe(false);
  });

  it('continues destroying plugins when an onDestroy hook fails', async () => {
    const manager = host();
    const destroyed: string[] = [];
    const errors: string[] = [];
    manager.onError = (name) => errors.push(name);
    await manager.register({
      name: 'broken-destroy',
      onDestroy: () => {
        throw new Error('destroy failed');
      },
    });
    await manager.register({
      name: 'healthy-destroy',
      onDestroy: () => void destroyed.push('healthy'),
    });

    await manager.destroy();

    expect(destroyed).toEqual(['healthy']);
    expect(errors).toEqual(['broken-destroy']);
    expect(manager.has('broken-destroy')).toBe(false);
    expect(manager.has('healthy-destroy')).toBe(false);
  });

  it('reports rejected unregister hooks without an unhandled rejection', async () => {
    const manager = host();
    const errors: Array<{ name: string; entry?: LogEntry }> = [];
    manager.onError = (name, _err, entry) => errors.push({ name, entry });
    await manager.register({
      name: 'async-destroy',
      onDestroy: async () => {
        throw new Error('async destroy failed');
      },
    });

    manager.unregister('async-destroy');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toEqual([{ name: 'async-destroy', entry: undefined }]);
    expect(manager.has('async-destroy')).toBe(false);
  });

  it('isolates onTransport errors and continues notifying plugins', async () => {
    const manager = host();
    const notified: string[] = [];
    const errors: string[] = [];
    manager.onError = (name) => errors.push(name);
    await manager.register({
      name: 'bad-transport-hook',
      onTransport: () => {
        throw new Error('transport hook failed');
      },
    });
    await manager.register({
      name: 'good-transport-hook',
      onTransport: (transport) => notified.push(transport.name),
    });

    expect(() => manager.notifyTransport({ name: 'new' } as Transport)).not.toThrow();
    expect(errors).toEqual(['bad-transport-hook']);
    expect(notified).toEqual(['new']);
  });
});
