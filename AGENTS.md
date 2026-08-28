# AGENTS.md

Guidance for AI coding agents working on **lograil** — a high-performance, secure logging library for Electron and Web runtimes.

## Project overview

- **lograil** is a TypeScript logging library with a layered architecture: `Core (Logger) -> Pipeline (Filter/Processor/Formatter) -> Transports`, isolated from runtime differences by `Runtime Adapters`, extended by `Plugins`, enriched by `Context`.
- Source layout (`src/`): `core/`, `pipeline/`, `transport/`, `runtime/`, `plugin/`, `context/`, plus `types.ts` and the `index.ts` public API.
- It ships dual-module builds (ESM + CJS) and is consumed as a zero-config `logger` that auto-detects its runtime (Electron main/renderer, Node, Web).
- Package manager is **yarn** (with Corepack). Node `>=18` (CI tests 20/22/24/26).

## Setup commands

- Install deps: `yarn install` (Corepack-enforced; `ELECTRON_SKIP_BINARY_DOWNLOAD=1` is set in CI so only Electron types are needed)
- Run tests: `yarn test` (vitest, single run)
- Typecheck: `yarn typecheck` (src) and `yarn typecheck:test` (tests)
- Lint: `yarn lint`
- Format: `yarn format` (Prettier), check with `yarn format:check`
- Build: `yarn build` (emits `dist/esm` and `dist/cjs`)
- Benchmarks: `yarn bench`
- Docs dev: `yarn docs:dev` (VitePress, `docs/`)

## Code style

- **TypeScript** with `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride` all enabled — code must be type-clean.
- **Prettier** is the formatter (enforced via ESLint's `prettier/prettier` rule). Config: `singleQuote: true`, `semi: true`, `trailingComma: 'all'`, `printWidth: 100`, `tabWidth: 2`. Run `yarn lint` to validate both lint and formatting.
- Prefer **type-only imports** (`import type`) — enforced by `@typescript-eslint/consistent-type-imports`.
- Prefix intentionally unused variables/args with `_` (e.g. `(_ctx, msg) => …`).
- Avoid `any` where possible; it is a warning, not an error.
- Internal module imports use explicit `.js` extensions (ESM resolution style), e.g. `import { Logger } from './core/logger.js'`.

## Testing instructions

- Tests live in `test/` as `*.test.ts` and run with **Vitest** (`yarn test`).
- Add or update tests for any behavior you change, including edge cases for filters, processors, formatters, transports, runtime adapters, and plugins.
- Run the full suite (`yarn test`) and `yarn lint` before considering a task done; CI runs lint → test → build on ubuntu/windows/macos across Node 20–26.
- For focused runs: `yarn vitest run <path>` or `yarn vitest run -t "<test name>"`.

## Architecture & contribution notes

- Keep the layering intact: core should not reach into runtime specifics; runtime differences belong in `runtime/` adapters.
- Public API surface is exported from `src/index.ts` — add new public exports there intentionally, and consider the `./*` subpath exports (`./core`, `./pipeline`, `./transport`, `./runtime`, `./plugin`, `./context`).
- The browser build swaps `runtime/electron-binding.js` for a browser-safe stub (see `package.json` `browser` field) — don't break that mapping.
- Prefer adding docs/examples in `docs/` (VitePress) and keep `README.md` concise for humans.

## Releasing

- Docs deploy automatically on version tags (`v*`) via `.github/workflows/docs.yml`.
- Do not commit to `dist/` (it is build output and gitignored via `files` in package.json).
