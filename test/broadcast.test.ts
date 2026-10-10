import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BroadcastChannelTransport,
  registerBroadcastChannelReceiver,
} from '../src/transport/broadcast.js';
import type { LogEntry } from '../src/types.js';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: 30,
    levelName: 'info',
    message: 'hello',
    args: [],
    timestamp: 0,
    time: '1970-01-01T00:00:00.000Z',
    scope: undefined,
    pid: undefined,
    context: {},
    metadata: {},
    error: undefined,
    ...overrides,
  } as unknown as LogEntry;
}

interface StubChannel {
  name: string;
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(m: unknown): void;
  close(): void;
}

/**
 * Stub the `BroadcastChannel` global with an in-process registry so multiple
 * instances with the same name can receive each other's messages.
 */
function installBroadcastChannelStub(): void {
  const channels = new Map<string, Set<StubChannel>>();
  class StubBroadcastChannel implements StubChannel {
    name: string;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(name: string) {
      this.name = name;
      let set = channels.get(name);
      if (!set) {
        set = new Set();
        channels.set(name, set);
      }
      set.add(this);
    }
    postMessage(m: unknown): void {
      const set = channels.get(this.name);
      if (!set) return;
      for (const ch of set) {
        if (ch !== this && ch.onmessage) ch.onmessage({ data: m });
      }
    }
    close(): void {
      channels.get(this.name)?.delete(this);
    }
  }
  vi.stubGlobal('BroadcastChannel', StubBroadcastChannel);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('BroadcastChannelTransport (import-safe)', () => {
  it('is constructible even where BroadcastChannel is undefined', () => {
    // In some hosts (older Node, some Electron builds) there is no global
    // BroadcastChannel. Force the "absent" path by stubbing it to undefined
    // and assert construction never throws.
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(() => new BroadcastChannelTransport()).not.toThrow();
  });

  it('write is a silent no-op when BroadcastChannel is absent', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const t = new BroadcastChannelTransport();
    const errs: unknown[] = [];
    t.onError = (e) => errs.push(e);
    t.write(makeEntry(), 'line');
    expect(errs).toHaveLength(0); // silently dropped, not an error
    t.close();
  });
});

describe('BroadcastChannelTransport (with BroadcastChannel stub)', () => {
  it('posts entries and delivers them to subscribers on the same channel', () => {
    installBroadcastChannelStub();
    const a = new BroadcastChannelTransport({ name: 'chan' });
    const b = new BroadcastChannelTransport({ name: 'chan' });
    const received: LogEntry[] = [];
    const off = b.subscribe((entry) => received.push(entry));
    a.write(makeEntry({ message: 'from A' }), 'line');
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe('from A');
    off();
    a.close();
    b.close();
  });

  it('does not echo to its own subscribers', () => {
    installBroadcastChannelStub();
    const t = new BroadcastChannelTransport({ name: 'solo' });
    const received: LogEntry[] = [];
    const off = t.subscribe((entry) => received.push(entry));
    t.write(makeEntry(), 'line');
    expect(received).toHaveLength(0);
    off();
    t.close();
  });

  it('unsubscribe stops delivery', () => {
    installBroadcastChannelStub();
    const a = new BroadcastChannelTransport({ name: 'chan2' });
    const b = new BroadcastChannelTransport({ name: 'chan2' });
    const received: LogEntry[] = [];
    const off = b.subscribe((entry) => received.push(entry));
    a.write(makeEntry({ message: 'first' }), 'line');
    off();
    a.write(makeEntry({ message: 'second' }), 'line');
    expect(received.map((e) => e.message)).toEqual(['first']);
    a.close();
    b.close();
  });

  it('different channel names do not cross-talk', () => {
    installBroadcastChannelStub();
    const a = new BroadcastChannelTransport({ name: 'chan-A' });
    const b = new BroadcastChannelTransport({ name: 'chan-B' });
    const received: LogEntry[] = [];
    const off = b.subscribe((entry) => received.push(entry));
    a.write(makeEntry({ message: 'A only' }), 'line');
    expect(received).toHaveLength(0);
    off();
    a.close();
    b.close();
  });
});

describe('registerBroadcastChannelReceiver', () => {
  it('returns an unregister function and forwards entries', () => {
    installBroadcastChannelStub();
    const sender = new BroadcastChannelTransport({ name: 'recv-chan' });
    const received: LogEntry[] = [];
    const off = registerBroadcastChannelReceiver((entry) => received.push(entry), {
      name: 'recv-chan',
    });
    sender.write(makeEntry({ message: 'to receiver' }), 'line');
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe('to receiver');
    off();
    sender.close();
  });
});
