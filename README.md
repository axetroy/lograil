<div align="center">
  <img src="./logo.svg" alt="lograil" width="128" height="128" />
</div>

# lograil

Structured, secure logging for **Electron** (main + renderer), **Node.js**, and the **Web** — with one zero-config `logger`, pluggable transports, filters, processors, formatters, and plugins.

In Electron, the main process writes logs to the console **and** daily rotating files, and renderer logs are forwarded over IPC automatically. The same `import { logger } from 'lograil'` works untouched in every runtime.

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
- Electron (incl. secure `contextIsolation` + preload setup)
- API reference

## License

MIT
