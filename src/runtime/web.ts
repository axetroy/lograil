import { ConsoleTransport } from '../transport/console.js';
import type { RuntimeAdapter } from './adapter.js';
import { createWebLifecycle } from './web-lifecycle.js';

/**
 * Web runtime (browsers). No process id, no filesystem, console only by
 * default. Remote HTTP transports can be added by the application.
 */
export function createWebRuntime(): RuntimeAdapter {
  return {
    name: 'web',
    now: () => Date.now(),
    pid: () => undefined,
    hasFileSystem: () => false,
    defaultTransports: () => [new ConsoleTransport()],
    lifecycle: createWebLifecycle(),
  };
}
