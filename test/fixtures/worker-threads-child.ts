// Worker script for worker_threads integration test
// Runs inside a real Node worker_threads worker
import { logger } from '../src/index.js';
import { createWebRuntime } from '../src/runtime/web.js';

// Override runtime so it detects worker_threads and uses WorkerIpcTransport
// eslint-disable-next-line @typescript-eslint/no-floating-promises
logger.init({ runtime: createWebRuntime() });

// Log some messages — they should be forwarded to the parent via postMessage
logger.info('hello from worker_threads');
logger.warn('worker warning');
