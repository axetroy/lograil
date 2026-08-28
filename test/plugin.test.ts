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
});
