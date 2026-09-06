/**
 * lograil — high-performance, secure universal logging for Web, Node.js and Electron.
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
 *
 * **Constraints — read before using in tests or long-lived processes:**
 *
 * - **Created synchronously at first import.** The constructor runs
 *   `detectRuntime()`, creates the default transports (including a
 *   `FileTransport` on Node / Electron main), and registers process lifecycle
 *   hooks (`beforeExit`, `SIGINT`, `SIGTERM`). There is no lazy init — any
 *   module that imports this one triggers those side effects immediately.
 * - **Single process-wide instance.** Because it is a module-level constant,
 *   all code in the same process shares the same logger, the same
 *   `AsyncLocalStorage`-backed ambient context, and the same set of
 *   `process.*` listeners. If you run multiple independent loggers in one
 *   process (e.g. a test harness), use `createLogger()` for each and only
 *   import this singleton when you want exactly one globally-shared logger.
 * - **Not automatically cleaned up.** Lifecycle hooks stay registered until
 *   you call {@link Logger.destroy} (which detaches them and flushes pending
 *   writes). In tests, call `await logger.destroy()` in an `afterAll` hook if
 *   the test imports this module and you want to keep the process clean for
 *   sibling tests.
 */
export const logger = createLogger();

export default logger;
