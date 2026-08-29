import type { RuntimeAdapter } from './adapter.js';
import type { Transport } from '../transport/transport.js';
import type { IpcRenderer } from 'electron';
import { ConsoleTransport } from '../transport/console.js';
import { ElectronIpcTransport } from '../transport/electron-ipc.js';
import { createWebLifecycle } from './web-lifecycle.js';

export interface ElectronRendererRuntimeOptions {
  /**
   * Forward entries to the main process over IPC so they are written there
   * (default `true`). Disable to keep renderer logs local only.
   */
  forwardToMain?: boolean;
  /** Override the IPC channel used to reach the main process. */
  channel?: string;
  /**
   * Injected IPC sender. Required when the renderer cannot reach
   * `require('electron')` (e.g. `nodeIntegration: false` +
   * `contextIsolation: true`) — pass the `ipcRenderer` obtained from a preload
   * bridge. Without it the transport falls back to `require('electron')`, which
   * is unavailable in that locked-down setup.
   */
  ipcRenderer?: Pick<IpcRenderer, 'send'>;
}

/**
 * Electron **renderer process** runtime. Renderers have no filesystem access,
 * so by default they forward entries to the main process (which persists
 * them) while still logging to the local console for devtools visibility.
 */
export function createElectronRendererRuntime(
  options: ElectronRendererRuntimeOptions = {},
): RuntimeAdapter {
  const forwardToMain = options.forwardToMain ?? true;

  return {
    name: 'electron',
    processType: 'renderer',
    now: () => Date.now(),
    pid: () => undefined,
    hasFileSystem: () => false,
    defaultTransports: () => {
      const transports: Transport[] = [new ConsoleTransport()];
      if (forwardToMain) {
        transports.push(
          new ElectronIpcTransport({
            channel: options.channel,
            ipcRenderer: options.ipcRenderer,
          }),
        );
      }
      return transports;
    },
    lifecycle: createWebLifecycle(),
  };
}
