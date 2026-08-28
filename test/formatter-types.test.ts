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

/** Normalize error stacks (and any cause chain) so snapshots are deterministic. */
function fixStack(err: Error): Error {
  err.stack = `${err.name}: ${err.message}\n    at <snapshot>`;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) fixStack(cause);
  return err;
}

function namedFn() {
  return 1;
}

function makeCauseError(): Error {
  const root = fixStack(new Error('root cause'));
  const wrap = new Error('wrap');
  (wrap as { cause?: unknown }).cause = root;
  return fixStack(wrap);
}

function makeCauseValueError(): Error {
  const e = new Error('with cause value');
  (e as { cause?: unknown }).cause = { code: 'E_TEST', detail: 'boom' };
  return fixStack(e);
}

const sym = Symbol('sym');
const dt = new Date(1_700_000_000_000);
const map = new Map<string, string>([['k', 'v']]);
const set = new Set<number>([1, 2]);
const plainErr = fixStack(new Error('boom'));
const causeErr = makeCauseError();
const causeVal = makeCauseValueError();
const circ: Record<string, unknown> = { name: 'circ' };
circ.self = circ;

// Self-referential cause (a.cause === a) must not cause infinite recursion.
const circularCause: Error & { cause?: unknown } = new Error('outer');
circularCause.stack = 'Error: outer\n    at <snapshot>';
circularCause.cause = circularCause;

async function render(value: unknown): Promise<{ line: string; json: string }> {
  const cap = new Capture();
  const log = new Logger({ runtime: fixedRuntime, transports: [cap], level: 'debug' });
  log.info(value);
  await log.flush();
  const e = cap.entries[0];
  return { line: createLineFormatter()(e), json: createJsonFormatter()(e) };
}

const cases: { name: string; value: unknown }[] = [
  { name: 'string', value: 'hello' },
  { name: 'empty-string', value: '' },
  { name: 'integer', value: 42 },
  { name: 'float', value: 3.14 },
  { name: 'nan', value: NaN },
  { name: 'infinity', value: Infinity },
  { name: 'negative-infinity', value: -Infinity },
  { name: 'boolean-true', value: true },
  { name: 'boolean-false', value: false },
  { name: 'null', value: null },
  { name: 'undefined', value: undefined },
  { name: 'bigint', value: 10n },
  { name: 'symbol', value: sym },
  { name: 'function', value: namedFn },
  { name: 'plain-object', value: { a: 1, b: { c: 2 } } },
  { name: 'array', value: [1, 2, 3] },
  { name: 'date', value: dt },
  { name: 'regexp', value: /regex/g },
  { name: 'map', value: map },
  { name: 'set', value: set },
  { name: 'error', value: plainErr },
  { name: 'error-with-cause-error', value: causeErr },
  { name: 'error-with-cause-value', value: causeVal },
  { name: 'error-circular-cause', value: circularCause },
  { name: 'circular', value: circ },
];

describe('formatter: per-type rendering (snapshot)', () => {
  for (const { name, value } of cases) {
    it(name, async () => {
      const { line, json } = await render(value);
      expect({ line, json }).toMatchSnapshot();
    });
  }
});

describe('formatter: edge-case assertions', () => {
  it('symbol / function are not rendered as the literal "undefined"', async () => {
    const { line: sl } = await render(sym);
    expect(sl).toContain('Symbol(sym)');
    const { line: fl } = await render(namedFn);
    expect(fl).toContain('[Function: namedFn]');
  });

  it('bigint renders as "10n" in both line and json', async () => {
    const { line, json } = await render(10n);
    expect(line).toContain('10n');
    expect(JSON.parse(json).args[0]).toBe('10n');
  });

  it('NaN is "NaN" in line but null in JSON (valid JSON)', async () => {
    const { line, json } = await render(NaN);
    expect(line).toContain('NaN');
    expect(JSON.parse(json).args[0]).toBeNull();
  });

  it('circular reference does not throw and renders [Circular]', async () => {
    const { line, json } = await render(circ);
    expect(line).toContain('[Circular]');
    expect(json).toContain('[Circular]');
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('Error cause chain is included (line + json)', async () => {
    const { line, json } = await render(causeErr);
    expect(line).toContain('caused by:');
    expect(line).toContain('root cause');
    const parsed = JSON.parse(json);
    expect(parsed.error.cause).toBeDefined();
    expect(parsed.error.cause.message).toBe('root cause');
    expect(parsed.error.cause.cause).toBeUndefined();
  });

  it('Error with a non-Error cause serializes the cause value', async () => {
    const { line, json } = await render(causeVal);
    expect(line).toContain('caused by:');
    const parsed = JSON.parse(json);
    expect(typeof parsed.error.cause).toBe('string');
    expect(parsed.error.cause).toContain('E_TEST');
  });

  it('circular Error.cause does not recurse infinitely', async () => {
    const { line, json } = await render(circularCause);
    expect(line).toContain('[Circular cause]');
    const parsed = JSON.parse(json);
    expect(parsed.error.cause.circular).toBe(true);
  });
});

describe('formatter: nested exotic types', () => {
  it('serializes exotic types nested inside objects/arrays', async () => {
    const value = {
      big: 10n,
      sym: Symbol('s'),
      fn: namedFn,
      map: new Map<string, string>([['k', 'v']]),
      set: new Set<number>([1]),
      nested: { big: 10n, ok: true },
    };
    const { line, json } = await render(value);
    expect(json).toContain('"__type":"Map"');
    expect(json).toContain('"__type":"Set"');
    expect(json).toContain('10n');
    expect(json).toContain('Symbol(s)');
    // line formatter renders the same values inline
    expect(line).toContain('10n');
    expect(line).toContain('Symbol(s)');
    expect(line).toContain('[Function: namedFn]');
  });
});

describe('formatter: combined (snapshot)', () => {
  it('renders a mix of types together', async () => {
    const cap = new Capture();
    const log = new Logger({ runtime: fixedRuntime, transports: [cap], level: 'debug' });
    log.info('mixed', 'hello', 42, 10n, sym, namedFn, { a: 1 }, map, set, plainErr);
    await log.flush();
    const e = cap.entries[0];
    expect({
      line: createLineFormatter()(e),
      json: createJsonFormatter()(e),
    }).toMatchSnapshot();
  });
});
