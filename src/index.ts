/**
 * lograil — high-performance, secure logging for Electron & Web.
 *
 * Layered architecture:
 *   Core (Logger) -> Pipeline (Filter/Processor/Formatter) -> Transports,
 *   isolated from runtime differences by Runtime Adapters, extended by Plugins,
 *   enriched by Context.
 */

export * from './types.js';

export * from './core/index.js';
export * from './pipeline/index.js';
export * from './transport/index.js';
export * from './runtime/index.js';
export * from './plugin/index.js';
export * from './context/index.js';

import type { LoggerOptions } from './core/logger.js';
import { Logger } from './core/logger.js';
import type { RuntimeAdapter } from './runtime/index.js';

/**
 * Create a root logger. The runtime is auto-detected (Electron vs Web) unless
 * an explicit adapter is supplied.
 */
export function createLogger(options?: LoggerOptions & { runtime?: RuntimeAdapter }): Logger {
  return new Logger(options);
}

/**
 * A ready-to-use root logger whose runtime (Web / Node / Electron) is
 * auto-detected at import time. Import it and log immediately — no setup
 * required:
 *
 *     import { logger } from 'lograil';
 *     logger.info('hello');
 *
 * It can still be reconfigured on the fly (`setLevel`, `addTransport`,
 * `scope`, …). Use {@link createLogger} when you need a separate, fully
 * customised instance.
 */
export const logger = createLogger();

export default logger;
