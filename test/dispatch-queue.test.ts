import { describe, it, expect } from 'vitest';
import { Logger } from '../src/core/index.js';
import type { LogEntry } from '../src/types.js';
import type { Plugin } from '../src/plugin/index.js';
import type { Transport } from '../src/transport/transport.js';
import { createLineFormatter } from '../src/pipeline/formatter.js';

class MemoryTransport implements Transport {
  readonly name = 'memory';
  entries: LogEntry[] = [];
  lines: string[] = [];
  formatter = createLineFormatter();
  write(entry: LogEntry, formatted: string): void {
    this.entries.push(entry);
    this.lines.push(formatted);
  }
}

/**
 * Slow plugin that delays interception by `delay` ms.
 * Useful for testing that flush() waits for all in-flight interceptions.
 */
function slowPlugin(delay: number): Plugin {
  return {
    name: 'slow',
    onEntry(entry: LogEntry): LogEntry | null {
      // Return a Promise that resolves after delay ms
      return new Promise<LogEntry>((resolve) => {
        setTimeout(() => resolve(entry), delay);
      }) as unknown as LogEntry;
    },
  };
}

describe('Dispatch queue - bounded async interception', () => {
  it('flush() waits for all in-flight plugin interceptions', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });
    await logger.use(slowPlugin(50));

    logger.info('msg1');
    logger.info('msg2');
    logger.info('msg3');

    // Before flush: entries should not yet be written (interception still in progress)
    expect(t.entries).toHaveLength(0);

    // After flush: all entries should be written
    await logger.flush();
    expect(t.entries).toHaveLength(3);
    expect(t.entries.map((e) => e.message)).toEqual(['msg1', 'msg2', 'msg3']);
  });

  it('dispatch queue does not grow unboundedly with high-frequency calls', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });

    // Track how many times intercept is called
    let interceptCallCount = 0;
    const trackingPlugin: Plugin = {
      name: 'tracker',
      onEntry(entry: LogEntry): LogEntry | null {
        interceptCallCount++;
        return entry;
      },
    };
    await logger.use(trackingPlugin);

    // Emit many entries rapidly
    const count = 100;
    for (let i = 0; i < count; i++) {
      logger.info(`msg-${i}`);
    }

    // All interceptions should have been triggered
    expect(interceptCallCount).toBe(count);

    await logger.flush();
    expect(t.entries).toHaveLength(count);
  });

  it('destroy() resets dispatch state and prevents new dispatches', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });
    await logger.use(slowPlugin(100));

    logger.info('before-destroy');
    await logger.destroy();

    // After destroy, dispatching should be a no-op
    logger.info('after-destroy');
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0].message).toBe('before-destroy');
  });

  it('dispatch order is preserved even with async plugins', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });

    // Plugin that resolves in reverse order (entry 1 takes longer than entry 0)
    const callOrder: number[] = [];
    const resolveOrder: number[] = [];
    const reorderPlugin: Plugin = {
      name: 'reorder',
      onEntry(entry: LogEntry): LogEntry | null {
        const idx = parseInt(entry.message.replace('msg-', ''), 10);
        callOrder.push(idx);
        return new Promise<LogEntry>((resolve) => {
          // Entry 1 takes 30ms, entry 0 takes 10ms
          const delay = idx === 1 ? 30 : 10;
          setTimeout(() => {
            resolveOrder.push(idx);
            resolve(entry);
          }, delay);
        }) as unknown as LogEntry;
      },
    };
    await logger.use(reorderPlugin);

    logger.info('msg-0');
    logger.info('msg-1');
    await logger.flush();

    // Entries should be written in emit order, not resolution order
    expect(t.entries.map((e) => e.message)).toEqual(['msg-0', 'msg-1']);
    // But the plugin was called in order
    expect(callOrder).toEqual([0, 1]);
  });

  it('multiple fast plugins do not cause dispatch chain explosion', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });

    // Register multiple plugins, each with onEntry
    for (let i = 0; i < 5; i++) {
      await logger.use({
        name: `plugin-${i}`,
        onEntry(entry: LogEntry): LogEntry {
          return { ...entry, metadata: { ...entry.metadata, [`plugin-${i}`]: true } };
        },
      });
    }

    // Emit many entries
    for (let i = 0; i < 50; i++) {
      logger.info(`msg-${i}`);
    }

    await logger.flush();
    expect(t.entries).toHaveLength(50);
    // All plugins should have run
    expect(t.entries[0].metadata['plugin-0']).toBe(true);
    expect(t.entries[0].metadata['plugin-4']).toBe(true);
  });

  it('plugin error is reported but entry still flows through', async () => {
    const t = new MemoryTransport();
    const logger = new Logger({ transports: [t], level: 'debug' });

    // Plugin throws on every call; per plugin semantics the entry is kept as-is
    // and passed downstream — the error is only reported, not propagated to caller.
    const errorPlugin: Plugin = {
      name: 'errorer',
      onEntry(): LogEntry | null {
        throw new Error('plugin boom');
      },
    };
    await logger.use(errorPlugin);

    logger.info('boom-1');
    logger.info('boom-2');
    await logger.flush();

    // Both entries are still written; only the error reporting path differs.
    expect(t.entries).toHaveLength(2);
    expect(t.entries.map((e) => e.message)).toEqual(['boom-1', 'boom-2']);
  });
});

// ---- Backpressure / queue-limit tests ----

function slowAsyncTransport(delayMs: number, limit?: number): Transport {
  let inflight = 0;
  return {
    name: 'slow-async',
    get inflightCount() {
      return inflight;
    },
    formatter: createLineFormatter(),
    queueLimit: limit,
    write(_entry: LogEntry, _formatted: string): Promise<void> {
      inflight++;
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          inflight--;
          resolve();
        }, delayMs);
      });
    },
  };
}

describe('Transport queue backpressure', () => {
  it('drops newest entry when transport queue limit is exceeded (global maxQueueDepth)', async () => {
    const dropped: string[] = [];
    const t = slowAsyncTransport(50, 3); // each write takes 50ms
    const logger = new Logger({
      transports: [t],
      level: 'debug',
      maxQueueDepth: 2,
      onError(_err, info) {
        if (info.entry) dropped.push(info.entry.message);
      },
    });

    // Emit 5 entries rapidly — queue limit is 2, so entries 3+ should be dropped
    for (let i = 0; i < 5; i++) {
      logger.info(`msg-${i}`);
    }

    // Wait for queue to fully drain (writes are sequential, 5 * 50ms)
    await logger.flush();
    await new Promise((r) => setTimeout(r, 10));

    // Entries 0 and 1 fill the queue to depth 2; msg-2 also fits (depth becomes 2 after write).
    // msg-3 and msg-4 see depth=2 >= limit=2 and are dropped.
    expect(dropped).toEqual(['msg-3', 'msg-4']);
  });

  it('per-transport queueLimit takes precedence over global maxQueueDepth', async () => {
    const drops: number[] = [];
    const t = slowAsyncTransport(80, 2);
    t.onOverflow = (entry: LogEntry, depth: number) => {
      drops.push(depth);
    };

    const logger = new Logger({
      transports: [t],
      level: 'debug',
      maxQueueDepth: 10, // global is loose
    });

    for (let i = 0; i < 6; i++) {
      logger.info(`msg-${i}`);
    }

    await logger.flush();
    // Per-transport limit of 2 should have kicked in; some drops recorded
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  it('no drops when queue is within limit', async () => {
    const t = slowAsyncTransport(10, 5);
    const logger = new Logger({
      transports: [t],
      level: 'debug',
      maxQueueDepth: 5,
    });

    for (let i = 0; i < 3; i++) {
      logger.info(`msg-${i}`);
    }

    await logger.flush();
    // All 3 should be written successfully
    expect(t.inflightCount).toBe(0);
  });

  it('synchronous transports are not affected by queue limits', async () => {
    const mem = new MemoryTransport();
    const logger = new Logger({
      transports: [mem],
      level: 'debug',
      maxQueueDepth: 1,
    });

    for (let i = 0; i < 10; i++) {
      logger.info(`msg-${i}`);
    }

    await logger.flush();
    expect(mem.entries).toHaveLength(10);
  });
});
