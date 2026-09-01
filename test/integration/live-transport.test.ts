/**
 * Integration tests for LiveTransport replay and buffering behaviour.
 *
 * These exercise the real transport (not mock subscribers) to catch regressions
 * in the buffer/closure contract that unit tests with vi.fn() callbacks miss.
 */
import { describe, it, expect } from 'vitest';
import { LiveTransport } from '../../src/transport/live.js';
import type { LogEntry } from '../../src/types.js';
import { LOG_LEVELS } from '../../src/types.js';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: LOG_LEVELS.info,
    levelName: 'info',
    message: 'hello',
    args: [],
    timestamp: 1_700_000_000_000,
    time: new Date(1_700_000_000_000).toISOString(),
    context: {},
    metadata: {},
    ...overrides,
  };
}

describe('integration: LiveTransport replay and buffering', () => {
  it('late subscriber receives a replay of the last N entries when bufferSize > 0', () => {
    const live = new LiveTransport({ bufferSize: 3 });

    // Write entries while there are no subscribers — they fill the buffer.
    live.write(makeEntry({ message: 'a' }), '');
    live.write(makeEntry({ message: 'b' }), '');
    live.write(makeEntry({ message: 'c' }), '');
    live.write(makeEntry({ message: 'd' }), ''); // should evict 'a'

    // A subscriber arriving after the fact gets only the last 3.
    const replayed: string[] = [];
    const n = live.replay((e) => replayed.push(e.message));
    expect(n).toBe(3);
    expect(replayed).toEqual(['b', 'c', 'd']);
  });

  it('newestFirst reverses the replay order', () => {
    const live = new LiveTransport({ bufferSize: 2 });
    live.write(makeEntry({ message: 'x' }), '');
    live.write(makeEntry({ message: 'y' }), '');

    const oldestFirst: string[] = [];
    const newestFirst: string[] = [];
    live.replay((e) => oldestFirst.push(e.message));
    live.replay((e) => newestFirst.push(e.message), true);

    expect(oldestFirst).toEqual(['x', 'y']);
    expect(newestFirst).toEqual(['y', 'x']);
  });

  it('replay is a one-shot snapshot — it does not subscribe the callback', () => {
    const live = new LiveTransport({ bufferSize: 2 });
    live.write(makeEntry({ message: 'pre' }), '');

    const snapshot: string[] = [];
    live.replay((e) => snapshot.push(e.message));

    live.write(makeEntry({ message: 'after' }), '');
    expect(snapshot).toEqual(['pre']); // snapshot is static
    expect(live.subscriberCount).toBe(0); // no persistent subscription created
  });

  it('subscribe after writes gives live forwarding but not replay', () => {
    const live = new LiveTransport({ bufferSize: 2 });
    live.write(makeEntry({ message: '1' }), '');
    live.write(makeEntry({ message: '2' }), '');
    live.write(makeEntry({ message: '3' }), ''); // drops '1'

    // subscribe() only adds the callback — no automatic replay.
    const seen: string[] = [];
    const unsub = live.subscribe((e) => seen.push(e.message));
    live.write(makeEntry({ message: '4' }), '');
    unsub();
    live.write(makeEntry({ message: '5' }), '');

    expect(seen).toEqual(['4']);
    expect(live.subscriberCount).toBe(0);
  });

  it('to get replay + live, call replay() before subscribe()', () => {
    const live = new LiveTransport({ bufferSize: 2 });
    live.write(makeEntry({ message: '1' }), '');
    live.write(makeEntry({ message: '2' }), '');
    live.write(makeEntry({ message: '3' }), ''); // drops '1'

    // First replay gets the buffered tail.
    const replayed: string[] = [];
    live.replay((e) => replayed.push(e.message));
    expect(replayed).toEqual(['2', '3']);

    // Then subscribe for live entries.
    const liveSeen: string[] = [];
    const unsub = live.subscribe((e) => liveSeen.push(e.message));
    live.write(makeEntry({ message: '4' }), '');
    unsub();
    live.write(makeEntry({ message: '5' }), '');

    expect(liveSeen).toEqual(['4']);
  });

  it('multiple late replays each get their own independent snapshot', () => {
    const live = new LiveTransport({ bufferSize: 2 });
    live.write(makeEntry({ message: 'a' }), '');
    live.write(makeEntry({ message: 'b' }), '');

    // replay() invokes the callback per entry — each call is independent.
    const snapA: string[] = [];
    const snapB: string[] = [];
    live.replay((e) => snapA.push(e.message));
    live.replay((e) => snapB.push(e.message));

    expect(snapA).toEqual(['a', 'b']);
    expect(snapB).toEqual(['a', 'b']);
  });

  it('replay returns 0 and does nothing when bufferSize is 0', () => {
    const live = new LiveTransport({ bufferSize: 0 });
    live.write(makeEntry({ message: 'orphan' }), '');
    expect(live.replay(() => undefined)).toBe(0);
  });

  it('clearBuffer empties the replay pool without affecting live subscribers', () => {
    const live = new LiveTransport({ bufferSize: 3 });
    live.write(makeEntry({ message: 'a' }), '');
    live.write(makeEntry({ message: 'b' }), '');
    live.clearBuffer();

    const snapshot: string[] = [];
    expect(live.replay((e) => snapshot.push(e.message))).toBe(0);
    expect(snapshot).toEqual([]);

    // Live subscriber still works after clear.
    const liveSeen: string[] = [];
    live.subscribe((e) => liveSeen.push(e.message));
    live.write(makeEntry({ message: 'c' }), '');
    expect(liveSeen).toEqual(['c']);
  });

  it('close() clears the buffer AND unsubscribes all live subscribers', () => {
    const live = new LiveTransport({ bufferSize: 2 });
    live.write(makeEntry({ message: 'x' }), '');
    live.write(makeEntry({ message: 'y' }), '');
    live.close();

    expect(live.replay(() => undefined)).toBe(0);
    expect(live.subscriberCount).toBe(0);

    // After close, a new subscribe also gets no replay (buffer was cleared).
    const seen: string[] = [];
    live.subscribe((e) => seen.push(e.message));
    live.write(makeEntry({ message: 'z' }), '');
    expect(seen).toEqual(['z']); // live forwarding still works on new sub
    expect(live.subscriberCount).toBe(1);
  });

  it('subscriber thrown error does not corrupt subsequent replays', () => {
    const live = new LiveTransport({ bufferSize: 2 });
    live.write(makeEntry({ message: 'good' }), '');
    live.write(makeEntry({ message: 'also-good' }), '');

    // First replay throws on one entry but succeeds on the other.
    const first: string[] = [];
    expect(() =>
      live.replay((e) => {
        if (e.message === 'good') throw new Error('boom');
        first.push(e.message);
      }),
    ).toThrow('boom');

    // Second replay is unaffected — buffer is intact.
    const second: string[] = [];
    live.replay((e) => second.push(e.message));
    expect(second).toEqual(['good', 'also-good']);
  });

  it('writes with active subscribers still maintain the bounded buffer', () => {
    const live = new LiveTransport({ bufferSize: 2 });
    const sink: string[] = [];
    live.subscribe((e) => sink.push(e.message));

    live.write(makeEntry({ message: '1' }), '');
    live.write(makeEntry({ message: '2' }), '');
    live.write(makeEntry({ message: '3' }), ''); // buffer full, evict '1'

    // Live subscriber gets everything (replay + live).
    expect(sink).toEqual(['1', '2', '3']);

    // Late replay only sees the last 2.
    const snap: string[] = [];
    live.replay((e) => snap.push(e.message));
    expect(snap).toEqual(['2', '3']);
  });

  it('replay callback is never invoked when buffer is empty', () => {
    const live = new LiveTransport({ bufferSize: 2 });
    let invoked = false;
    live.replay(() => {
      invoked = true;
    });
    expect(invoked).toBe(false);
  });
});
