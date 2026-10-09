import { describe, it, expect } from 'vitest';

// P2-12: the ConsoleTransport module must not throw at import time when the
// global `console` is undefined. A minimal edge runtime (or a test harness)
// may delete the global before lograil loads; without the guard the
// module-top-level `.bind(console)` calls would throw and take down the
// whole library.

describe('ConsoleTransport module load guard (P2-12)', () => {
  it('importing the module does not throw when global console is undefined', async () => {
    const original = globalThis.console;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).console = undefined;
    try {
      // Dynamic import so the module-top-level guard runs AFTER the delete.
      const mod = await import('../src/transport/console.js');
      // The module loaded without throwing. Constructing it must still work.
      const t = new mod.ConsoleTransport();
      expect(t.name).toBe('console');
    } finally {
      globalThis.console = original;
    }
  });

  it('falls back to no-op methods (no crash) when console is missing', async () => {
    const original = globalThis.console;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).console = undefined;
    try {
      const mod = await import('../src/transport/console.js');
      const t = new mod.ConsoleTransport();
      const entry = {
        level: 30,
        levelName: 'info',
        message: 'hello',
        args: [],
        timestamp: 0,
        time: '',
        context: {},
        metadata: {},
      } as Parameters<typeof t.write>[0];
      // Must not throw even though the underlying method is a no-op.
      t.write(entry, 'hello');
    } finally {
      globalThis.console = original;
    }
  });
});
