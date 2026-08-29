import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConsoleTransport,
  RotatingFileTransport,
  createLineFormatter,
  createLogger,
} from '../../src/index.js';

describe('integration: Node real file output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lograil-node-int-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes formatted entries to a real file and keeps structured fields', async () => {
    const file = join(dir, 'app.log');
    const logger = createLogger({
      level: 'debug',
      transports: [
        new ConsoleTransport({ formatter: createLineFormatter() }),
        new RotatingFileTransport({ path: file, daily: false, formatter: createLineFormatter() }),
      ],
    });

    logger.debug('debug line');
    logger.info('hello world', { userId: 42 });
    logger.warn('warn line');
    logger.error('failed', new Error('boom'));
    await logger.flush();

    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    // debug + info + warn + error are all >= debug; the error entry's stack
    // spans several lines, so we only assert a lower bound here.
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(text).toContain('hello world');
    expect(text).toContain('userId');
    expect(text).toContain('42');
    expect(text).toContain('failed');
    expect(text).toContain('boom');
  });

  it('drops entries below the logger level on the real file', async () => {
    const file = join(dir, 'filtered.log');
    const logger = createLogger({
      level: 'warn',
      transports: [
        new RotatingFileTransport({ path: file, daily: false, formatter: createLineFormatter() }),
      ],
    });

    logger.debug('nope');
    logger.info('also nope');
    logger.warn('kept');
    logger.error('kept too');
    await logger.flush();

    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('nope');
    expect(text).toContain('kept');
    expect(text).toContain('kept too');
  });
});
