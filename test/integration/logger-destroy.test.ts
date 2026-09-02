/**
 * Integration tests for Logger.destroy() edge cases.
 *
 * The unit tests cover the destroy sequence in isolation; these exercises the
 * real Logger (with a real transport and pipeline) to catch regressions in the
 * interactively-used paths: concurrent writes during destroy, re-entrant
 * destroy, and flush-then-destroy ordering.
 */
import { describe, it, expect } from 'vitest';
import { Logger } from '../../src/core/logger.js';
import type { LogEntry } from '../../src/types.js';
import type { Transport } from '../../src/transport/transport.js';
import { createLineFormatter } from '../../src/pipeline/formatter.js';

function makeSink(): { entries: LogEntry[]; transport: Transport } {
  const entries: LogEntry[] = [];
  const transport: Transport = {
    name: 'sink',
    write: (e: LogEntry) => void entries.push(e),
  };
  return { entries, transport };
}

describe('integration: Logger.destroy() edge cases', () => {
  it('does not throw when called multiple times (idempotent)', async () => {
    const { entries, transport } = makeSink();
    const log = new Logger({
      transports: [transport],
      level: 'debug',
      pipeline: { formatter: createLineFormatter() },
    });
    log.info('before first destroy');
    await log.destroy();
    // Second destroy must be safe.
    await expect(log.destroy()).resolves.toBeUndefined();
    expect(entries).toHaveLength(1);
  });

  it('flushes queued writes before close when destroy is awaited', async () => {
    const { entries, transport } = makeSink();
    const log = new Logger({
      transports: [transport],
      level: 'debug',
      pipeline: { formatter: createLineFormatter() },
    });
    log.info('queued-one');
    log.info('queued-two');
    // Await destroy directly — it should internally flush first.
    await log.destroy();
    expect(entries.map((e) => e.message)).toEqual(['queued-one', 'queued-two']);
  });

  it('subsequent writes after destroy are silently dropped, not queued', async () => {
    const { entries, transport } = makeSink();
    const log = new Logger({
      transports: [transport],
      level: 'debug',
      pipeline: { formatter: createLineFormatter() },
    });
    await log.destroy();
    log.info('post-destroy');
    await log.flush();
    expect(entries).toHaveLength(0);
  });

  it('flush before destroy does not duplicate entries written during flush', async () => {
    const { entries, transport } = makeSink();
    const log = new Logger({
      transports: [transport],
      level: 'debug',
      pipeline: { formatter: createLineFormatter() },
    });
    log.info('pre-flush');
    // Flush explicitly before destroy — should not double-count.
    await log.flush();
    await log.destroy();
    expect(entries.map((e) => e.message)).toEqual(['pre-flush']);
  });

  it('destroy with a stalled transport times out instead of hanging', async () => {
    const stall: Transport = {
      name: 'stall',
      write: () => new Promise<void>(() => {}), // never resolves
    };
    const log = new Logger({
      transports: [stall],
      level: 'debug',
      flushTimeoutMs: 30,
    });
    log.info('entry before stall');
    // destroy() must not block forever; it uses flushWithTimeout internally.
    await expect(log.destroy()).resolves.toBeUndefined();
  });
});
