import { describe, it, expect } from 'vitest';
import { logger, createLogger, Logger } from '../src/index.js';

describe('default logger entry', () => {
  it('exports a usable singleton logger', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.scope).toBe('function');
  });

  it('auto-detects a runtime with at least one transport', () => {
    expect(logger.getTransports().length).toBeGreaterThan(0);
  });

  it('createLogger still produces independent instances', () => {
    const a = createLogger();
    const b = createLogger();
    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(Logger);
  });
});
