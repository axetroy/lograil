import { describe, it, expect } from 'vitest';
import { Logger } from '../src/core/index.js';
import {
  Pipeline,
  createLevelFilter,
  createRedactProcessor,
  createJsonFormatter,
} from '../src/pipeline/index.js';
import { LOG_LEVELS } from '../src/types.js';
import type { LogEntry } from '../src/types.js';
import type { Plugin } from '../src/plugin/index.js';
import type { Transport } from '../src/transport/transport.js';
import type { RuntimeAdapter } from '../src/runtime/index.js';

class MemoryTransport implements Transport {
  readonly name = 'memory';
  entries: LogEntry[] = [];
  lines: string[] = [];
  write(entry: LogEntry, formatted: string): void {
    this.entries.push(entry);
    this.lines.push(formatted);
  }
}

function webRuntime(): RuntimeAdapter {
  return {
    name: 'web',
    now: () => 0,
    pid: () => undefined,
    hasFileSystem: () => false,
    defaultTransports: () => [],
  };
}

describe('Integration: Logger → Pipeline → Plugin → Transport', () => {
  it('filters, redacts, tags and formats end-to-end', async () => {
    const mem = new MemoryTransport();
    const pipeline = new Pipeline({
      filters: [createLevelFilter(LOG_LEVELS.info)],
      processors: [createRedactProcessor(['password'])],
      formatter: createJsonFormatter(),
    });
    const tag: Plugin = {
      name: 'tag',
      onEntry(entry) {
        return { ...entry, metadata: { ...entry.metadata, env: 'test' } };
      },
    };

    const log = new Logger({
      transports: [mem],
      runtime: webRuntime(),
      level: 'debug',
      pipeline,
    });
    await log.use(tag);

    log.setContext('password', 'super-secret');
    log.debug('filtered-out'); // below the info filter
    log.info('hello');
    log.scope('svc', { requestId: 'r1' }).warn('careful');

    await log.flush();

    // Only info + warn pass the level filter.
    expect(mem.entries).toHaveLength(2);
    expect(mem.entries.map((e) => e.levelName)).toEqual(['info', 'warn']);

    // Redaction applied to context.
    expect(mem.entries[0].context.password).toBe('[REDACTED]');

    // Plugin metadata injected.
    expect(mem.entries[0].metadata.env).toBe('test');

    // Child scope + context preserved.
    expect(mem.entries[1].scope).toBe('svc');
    expect(mem.entries[1].context.requestId).toBe('r1');

    // JSON formatter output reflects redaction.
    const json = JSON.parse(mem.lines[0]) as { context: Record<string, unknown> };
    expect(json.context.password).toBe('[REDACTED]');
  });
});

describe('Integration: Electron renderer → main (IPC ingestion)', () => {
  it('forwards renderer entries into the main logger and writes them', async () => {
    const mainMem = new MemoryTransport();
    const mainLog = new Logger({
      transports: [mainMem],
      runtime: webRuntime(),
      level: 'debug',
    });

    // Simulate the IPC channel: renderer's send reaches main's ingestEntry.
    // (`registerIpcReceiver` wires this the same way in a real Electron app.)
    const bridge = (entry: LogEntry): void => mainLog.ingestEntry(entry);
    const rendererToMain: Transport = {
      name: 'ipc',
      write(entry) {
        bridge(entry);
      },
    };

    const rendererMem = new MemoryTransport();
    const rendererLog = new Logger({
      transports: [rendererToMain, rendererMem],
      runtime: webRuntime(),
      level: 'debug',
      scope: 'renderer',
    });

    rendererLog.info('from renderer');
    await rendererLog.flush();
    await mainLog.flush();

    // The entry is written locally by the renderer AND received/persisted by
    // the main logger through the bridge.
    expect(rendererMem.entries).toHaveLength(1);
    expect(mainMem.entries).toHaveLength(1);
    expect(mainMem.entries[0].scope).toBe('renderer');
    expect(mainMem.entries[0].message).toBe('from renderer');
  });

  it('applies the main logger level to ingested renderer entries', async () => {
    const mainMem = new MemoryTransport();
    const mainLog = new Logger({
      transports: [mainMem],
      runtime: webRuntime(),
      level: 'warn', // main only persists warn+
    });

    mainLog.ingestEntry({
      level: 30, // info
      levelName: 'info',
      message: 'renderer info',
      args: [],
      timestamp: 1,
      time: new Date(1).toISOString(),
      context: {},
      metadata: {},
    });
    await mainLog.flush();

    expect(mainMem.entries).toHaveLength(0);
  });
});
