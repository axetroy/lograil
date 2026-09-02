import { describe, it, expect } from 'vitest';
import { Logger } from '../src/core/index.js';
import type { LogEntry } from '../src/types.js';
import type { RuntimeAdapter } from '../src/runtime/index.js';
import type { Transport } from '../src/transport/transport.js';
import { createLineFormatter, createJsonFormatter } from '../src/pipeline/formatter.js';

const fixedRuntime: RuntimeAdapter = {
  name: 'node',
  now: () => 1_700_000_000_000,
  pid: () => 1234,
  hasFileSystem: () => true,
  defaultTransports: () => [],
};

class Capture implements Transport {
  readonly name = 'capture';
  entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

async function capture(fn: (log: Logger) => void): Promise<LogEntry[]> {
  const cap = new Capture();
  const log = new Logger({ runtime: fixedRuntime, transports: [cap], level: 'debug' });
  fn(log);
  await log.flush();
  // Normalize error stacks so snapshots are environment-independent.
  for (const e of cap.entries) {
    if (e.error) {
      const err = e.error as { stack?: string; message?: string };
      err.stack = `Error: ${err.message ?? String(err)}\n    at <snapshot>`;
    }
  }
  return cap.entries;
}

describe('snapshot: structured LogEntry', () => {
  it('info entry with object arg, context and error', async () => {
    const entries = await capture((log) => {
      log.setContext('app', 'demo');
      log.info('user logged in', { userId: 42 }, new Error('boom'));
    });
    expect(entries[0]).toMatchSnapshot();
  });

  it('scoped child entry inherits context', async () => {
    const entries = await capture((log) => {
      log.setContext('requestId', 'r1');
      log.scope('auth').warn('token expired');
    });
    expect(entries[0]).toMatchSnapshot();
  });
});

describe('snapshot: formatter rendering', () => {
  it('line formatter', async () => {
    const [e] = await capture((log) => {
      log.setContext('app', 'demo');
      log.info('user logged in', { userId: 42 }, new Error('boom'));
    });
    expect(createLineFormatter()(e)).toMatchSnapshot();
  });

  it('json formatter', async () => {
    const [e] = await capture((log) => {
      log.setContext('app', 'demo');
      log.info('user logged in', { userId: 42 }, new Error('boom'));
    });
    expect(createJsonFormatter()(e)).toMatchSnapshot();
  });
});

describe('snapshot: additional scenarios', () => {
  it('warn entry with scope and args', async () => {
    const entries = await capture((log) => {
      log.setContext('module', 'auth');
      log.scope('request').warn('token expired', { tokenId: 't-42' });
    });
    expect(entries[0]).toMatchSnapshot();
  });

  it('error entry with context and message', async () => {
    const entries = await capture((log) => {
      log.setContext('app', 'backend');
      log.error('database connection failed', { host: 'db.internal' });
    });
    expect(entries[0]).toMatchSnapshot();
    expect(createLineFormatter()(entries[0])).toMatchSnapshot();
  });
});
