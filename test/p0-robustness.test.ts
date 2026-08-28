import { describe, it, expect, vi } from 'vitest';
import { Logger } from '../src/core/logger.js';
import type { Transport } from '../src/transport/transport.js';
import type { LogEntry } from '../src/types.js';

describe('P0: internal errors never crash the caller', () => {
  it('a throwing processor is reported and the entry still ships', () => {
    const written: LogEntry[] = [];
    const errors: string[] = [];
    const transport: Transport = {
      name: 'spy',
      write(entry) {
        written.push(entry);
      },
    };
    const logger = new Logger({
      transports: [transport],
      onError: (_err, info) => errors.push(info.phase),
    });
    logger.getPipeline().addProcessor(() => {
      throw new Error('boom');
    });

    expect(() => logger.info('hello')).not.toThrow();
    expect(written.length).toBe(1);
    expect(written[0].message).toBe('hello');
    expect(errors).toEqual(['process']);
  });

  it('a throwing filter drops the entry and is reported', () => {
    const written: LogEntry[] = [];
    const errors: string[] = [];
    const transport: Transport = {
      name: 'spy',
      write(entry) {
        written.push(entry);
      },
    };
    const logger = new Logger({
      transports: [transport],
      onError: (_err, info) => errors.push(info.phase),
    });
    logger.getPipeline().addFilter(() => {
      throw new Error('filterfail');
    });

    expect(() => logger.info('x')).not.toThrow();
    expect(written.length).toBe(0);
    expect(errors).toEqual(['filter']);
  });

  it('a throwing plugin onEntry keeps the entry and is reported with its name', async () => {
    const written: LogEntry[] = [];
    const errors: Array<{ phase: string; source?: string }> = [];
    const transport: Transport = {
      name: 'spy',
      write(entry) {
        written.push(entry);
      },
    };
    const logger = new Logger({
      transports: [transport],
      onError: (_err, info) => errors.push({ phase: info.phase, source: info.source }),
    });
    await logger.use({
      name: 'faulty',
      onEntry: () => {
        throw new Error('pluginfail');
      },
    });

    logger.info('y');
    await logger.flush();
    expect(written.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0].phase).toBe('plugin');
    expect(errors[0].source).toBe('faulty');
  });

  it('a throwing formatter falls back to a safe string and is reported', () => {
    const written: string[] = [];
    const errors: string[] = [];
    const transport: Transport = {
      name: 'spy',
      formatter: () => {
        throw new Error('fmtfail');
      },
      write(_entry, formatted) {
        written.push(formatted);
      },
    };
    const logger = new Logger({
      transports: [transport],
      onError: (_err, info) => errors.push(info.phase),
    });

    logger.info('hi');
    expect(written).toEqual(['[formatting failed] hi']);
    expect(errors).toEqual(['formatter']);
  });

  it('a transport whose write throws synchronoussly reports via its onError hook', () => {
    const onErr = vi.fn();
    const transport: Transport = {
      name: 'spy',
      onError: onErr,
      write() {
        throw new Error('writepanic');
      },
    };
    const logger = new Logger({ transports: [transport] });

    expect(() => logger.info('z')).not.toThrow();
    expect(onErr).toHaveBeenCalledTimes(1);
    expect((onErr.mock.calls[0][0] as Error).message).toBe('writepanic');
  });

  it('a stalled async transport cannot hang flush()', async () => {
    const onErr = vi.fn();
    const transport: Transport = {
      name: 'slow',
      onError: onErr,
      write() {
        // Never resolves.
        return new Promise<void>(() => {});
      },
    };
    const logger = new Logger({
      transports: [transport],
      onError: onErr,
      writeTimeoutMs: 80,
    });

    logger.info('stuck');
    // flush() must resolve despite the never-ending write.
    await expect(logger.flush()).resolves.toBeUndefined();
    // The timeout surfaced the failure to the transport hook.
    expect(onErr).toHaveBeenCalled();
  });

  it('without a custom onError, internal errors are swallowed (never throw)', () => {
    const transport: Transport = {
      name: 'spy',
      write() {
        throw new Error('nohook');
      },
    };
    const logger = new Logger({ transports: [transport] });
    expect(() => logger.info('q')).not.toThrow();
  });
});
