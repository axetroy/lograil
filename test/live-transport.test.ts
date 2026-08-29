import { describe, it, expect, vi } from 'vitest';
import { LiveTransport } from '../src/transport/live.js';
import { createLineFormatter } from '../src/pipeline/formatter.js';
import type { LogEntry } from '../src/types.js';
import { LOG_LEVELS } from '../src/types.js';

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    level: LOG_LEVELS.info,
    levelName: 'info',
    message: 'hello',
    args: [{ a: 1 }],
    timestamp: 1_700_000_000_000,
    time: new Date(1_700_000_000_000).toISOString(),
    context: { user: 'alice' },
    metadata: {},
    ...over,
  };
}

describe('LiveTransport', () => {
  it('forwards every written entry to subscribers', () => {
    const live = new LiveTransport();
    const seen: LogEntry[] = [];
    const unsub = live.subscribe((e) => seen.push(e));

    live.write(makeEntry({ message: 'a' }));
    live.write(makeEntry({ message: 'b' }));

    expect(seen.map((e) => e.message)).toEqual(['a', 'b']);
    expect(live.subscriberCount).toBe(1);

    unsub();
    live.write(makeEntry({ message: 'c' }));
    expect(seen.map((e) => e.message)).toEqual(['a', 'b']);
    expect(live.subscriberCount).toBe(0);
  });

  it('supports multiple independent subscribers', () => {
    const live = new LiveTransport();
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = live.subscribe((e) => a.push(e.message));
    live.subscribe((e) => b.push(e.message));

    live.write(makeEntry({ message: 'x' }));
    unsubA();
    live.write(makeEntry({ message: 'y' }));

    expect(a).toEqual(['x']);
    expect(b).toEqual(['x', 'y']);
  });

  it('isolates a throwing subscriber from the stream and other subscribers', () => {
    const live = new LiveTransport();
    const good: string[] = [];
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    live.subscribe(bad);
    live.subscribe((e) => good.push(e.message));

    // Should not throw out of write().
    expect(() => live.write(makeEntry({ message: 'z' }))).not.toThrow();
    expect(good).toEqual(['z']);
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('does not invoke subscribers after close()', () => {
    const live = new LiveTransport();
    const seen: string[] = [];
    live.subscribe((e) => seen.push(e.message));
    live.close();
    live.write(makeEntry({ message: 'nope' }));
    expect(seen).toEqual([]);
    expect(live.subscriberCount).toBe(0);
  });

  it('onFormatted passes the formatted line', () => {
    const live = new LiveTransport({ formatter: createLineFormatter() });
    const lines: string[] = [];
    live.onFormatted((line) => lines.push(line));
    live.write(makeEntry({ message: 'fmt' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('fmt');
  });

  it('buffers entries when bufferSize > 0 and replays them', () => {
    const live = new LiveTransport({ bufferSize: 2 });
    live.write(makeEntry({ message: '1' }));
    live.write(makeEntry({ message: '2' }));
    live.write(makeEntry({ message: '3' })); // drops '1'

    const replayed: string[] = [];
    const n = live.replay((e) => replayed.push(e.message));
    expect(n).toBe(2);
    expect(replayed).toEqual(['2', '3']);

    const newest: string[] = [];
    live.replay((e) => newest.push(e.message), true);
    expect(newest).toEqual(['3', '2']);
  });

  it('does not buffer when bufferSize is 0 (default)', () => {
    const live = new LiveTransport();
    live.write(makeEntry({ message: 'x' }));
    expect(live.replay(() => {})).toBe(0);
  });

  it('clearBuffer empties the buffer', () => {
    const live = new LiveTransport({ bufferSize: 5 });
    live.write(makeEntry({ message: 'x' }));
    live.clearBuffer();
    expect(live.replay(() => {})).toBe(0);
  });
});
