// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ConsoleTransport } from '../../src/transport/console.js';
import { createLogger, createWebRuntime } from '../../src/index.js';
import type { LogEntry } from '../../src/types.js';

describe('integration: web runtime (jsdom)', () => {
  it('uses the web runtime and writes structured lines through its console transport', () => {
    const captured: string[] = [];
    const recordingFormatter = (entry: LogEntry): string => {
      captured.push(entry.message);
      return `${entry.levelName}: ${entry.message}`;
    };
    const transport = new ConsoleTransport({ formatter: recordingFormatter });

    // The web runtime has no filesystem, so its default transport is the
    // console. Exercise that real transport path inside jsdom (browser-like).
    const logger = createLogger({
      level: 'debug',
      runtime: createWebRuntime(),
      transports: [transport],
    });
    logger.info('web info line');
    logger.warn('web warn line');
    logger.error('web error line');

    expect(captured).toContain('web info line');
    expect(captured).toContain('web warn line');
    expect(captured).toContain('web error line');
  });

  it('respects the level filter in the web runtime', () => {
    const captured: string[] = [];
    const recordingFormatter = (entry: LogEntry): string => {
      captured.push(entry.message);
      return `${entry.levelName}: ${entry.message}`;
    };
    const transport = new ConsoleTransport({ formatter: recordingFormatter });

    const logger = createLogger({
      level: 'warn',
      runtime: createWebRuntime(),
      transports: [transport],
    });
    logger.info('suppressed info');
    logger.warn('visible warn');

    expect(captured).not.toContain('suppressed info');
    expect(captured).toContain('visible warn');
  });
});
