'use strict';

const { app, ipcMain } = require('electron');
const { join } = require('node:path');
const {
  createLogger,
  createElectronMainRuntime,
  ElectronIpcTransport,
  RotatingFileTransport,
  RENDERER_PROCESS_MARKER,
} = require('lograil');

async function main() {
  const dir = process.env.LOGRAIL_TEST_DIR;

  // Main logger: receiveFromRenderer:true wires registerIpcReceiver onto the
  // real ipcMain channel automatically (via the runtime's attachReceiver). Two
  // real files: main-process entries -> main.log, renderer entries -> renderer.log.
  const logger = createLogger({
    level: 'debug',
    runtime: createElectronMainRuntime({ receiveFromRenderer: true, disableFile: true }),
    transports: [
      new RotatingFileTransport({
        path: join(dir, 'main.log'),
        daily: false,
        filter: (e) => e.metadata?.[RENDERER_PROCESS_MARKER] !== 'renderer',
      }),
      new RotatingFileTransport({
        path: join(dir, 'renderer.log'),
        daily: false,
        filter: (e) => e.metadata?.[RENDERER_PROCESS_MARKER] === 'renderer',
      }),
    ],
  });

  logger.info('hello from main');

  // Loop a real ElectronIpcTransport send straight into the real ipcMain
  // EventEmitter. This exercises the transport's real encode + postMessage path
  // AND the receiver's real decode + renderer-marking path + the real file
  // write — only Electron's internal cross-process transfer (its own plumbing)
  // is stubbed out, because ipcRenderer->ipcMain does not loop back in a single
  // process.
  const loopbackIpc = {
    postMessage: (channel, buffer) => ipcMain.emit(channel, {}, buffer),
  };
  const rendererTransport = new ElectronIpcTransport({ ipcRenderer: loopbackIpc });
  const base = { args: [], timestamp: Date.now(), time: '', context: {}, metadata: {} };
  rendererTransport.write({
    ...base,
    levelName: 'info',
    level: 30,
    message: 'hello from renderer',
  });
  rendererTransport.write({ ...base, levelName: 'warn', level: 40, message: 'renderer warning' });

  setTimeout(async () => {
    logger.info('main done');
    await logger.flush();
    console.log('LOGRAIL_DONE');
    app.quit();
  }, 1500);
}

app.whenReady().then(main);
