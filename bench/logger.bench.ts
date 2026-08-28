import { bench, describe } from 'vitest';
import type { RuntimeAdapter } from '../src/runtime/index.js';
import { createLogger } from '../src/index.js';
import { Pipeline } from '../src/pipeline/index.js';
import { createLineFormatter, createJsonFormatter } from '../src/pipeline/formatter.js';
import {
  createLevelFilter,
  createRedactProcessor,
  createScopeFilter,
} from '../src/pipeline/index.js';
import { createContextStore } from '../src/context/index.js';
import type { Transport } from '../src/transport/transport.js';
import type { LogEntry } from '../src/types.js';

// A runtime that contributes no default transports, so we measure the library's
// own overhead (build entry → pipeline → format → transport) rather than I/O.
const runtime = {
  name: 'node',
  now: () => Date.now(),
  pid: () => 1,
  hasFileSystem: () => false,
  defaultTransports: () => [],
} as unknown as RuntimeAdapter;

const noop: Transport = { name: 'noop', write() {} };

function makeLogger(extra: Parameters<typeof createLogger>[0] = {}) {
  return createLogger({ runtime, transports: [noop], ...extra });
}

const logLine = makeLogger(); // default line formatter
const logNoFmt = makeLogger({ pipeline: { formatter: ((e: LogEntry) => e) as never } });
const logWithPipe = makeLogger({
  pipeline: {
    filters: [createLevelFilter(0), createScopeFilter(['a', 'b'])],
    processors: [createRedactProcessor(['password', 'token'])],
  },
});
const logScoped = makeLogger().scope('auth', { requestId: 'r1' });
const logLevelFiltered = makeLogger({ level: 'info' }); // debug() should early-return
const logPlugin = makeLogger({
  plugins: undefined,
});
// attach a no-op entry interceptor plugin
void logPlugin.use({ name: 'interceptor', onEntry: (e) => e });

const lineFmt = createLineFormatter();
const jsonFmt = createJsonFormatter();
const pipeline = new Pipeline({
  filters: [createLevelFilter(0), createScopeFilter(['a', 'b'])],
  processors: [createRedactProcessor(['password', 'token'])],
});
const ctx = createContextStore({ user: 'alice', tenant: 'acme' });

const sample: LogEntry = {
  level: 4,
  levelName: 'info',
  message: 'user logged in',
  args: [{ userId: 42, plan: 'pro' }],
  timestamp: Date.now(),
  time: new Date().toISOString(),
  scope: 'auth',
  pid: 1,
  context: { requestId: 'abc' },
  metadata: {},
  error: undefined,
};

describe('emit (noop transport)', () => {
  bench('info, line formatter', () => {
    logLine.info('hello', { a: 1 });
  });

  bench('info with object arg', () => {
    logLine.info('event', { userId: 42, plan: 'pro' });
  });

  bench('info, identity formatter (no format cost)', () => {
    logNoFmt.info('hello', { a: 1 });
  });

  bench('level-filtered debug (early return)', () => {
    logLevelFiltered.debug('should not build an entry');
  });

  bench('scoped logger info', () => {
    logScoped.info('token refreshed');
  });

  bench('with filters + redact processor', () => {
    logWithPipe.info('login', { user: 'bob', password: 'secret' });
  });

  bench('with plugin onEntry (async intercept)', () => {
    logPlugin.info('via plugin');
  });
});

describe('formatters', () => {
  bench('line formatter', () => {
    lineFmt(sample);
  });
  bench('json formatter', () => {
    jsonFmt(sample);
  });
});

describe('pipeline.process', () => {
  bench('2 filters + 1 processor', () => {
    pipeline.process(sample);
  });
});

describe('context', () => {
  bench('store.get()', () => {
    ctx.get();
  });
});
