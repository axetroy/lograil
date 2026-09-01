<div align="center">
  <img src="https://raw.githubusercontent.com/axetroy/electron-logger/refs/heads/main/logo.svg" alt="lograil" width="128" height="128" />
</div>

# lograil

Structured, secure logging for **Web**, **Node.js**, and **Electron** — three first-class runtimes, one zero-config `logger`, pluggable transports, filters, processors, formatters, and plugins. Extend to any other platform through the plugin and runtime-adapter APIs.

The same `import { logger } from 'lograil'` works untouched in every runtime. On Electron, the main process writes logs to the console **and** daily rotating files, and renderer logs are forwarded over IPC automatically; on Node it persists to a rotating file by default; in the browser it speaks the console and any remote transport you add.

## Install

```bash
npm install lograil
# yarn / pnpm / bun add lograil
```

## Quick start

```ts
import { logger } from 'lograil';

logger.info('app started', { version: '1.0.0' });
logger.error(new Error('something went wrong'));
```

Need custom behavior? Use `createLogger({ level, pipeline, transports, runtime })` and the plugin API.

## Documentation

Full guides, API reference, and examples are on the **docs site**:

**https://axetroy.github.io/lograil/**

- Getting started · Configuration · Transports · Plugins
- Runtimes (Web, Node.js, Electron) & extending to others via plugins

## License

MIT
