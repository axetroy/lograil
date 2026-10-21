# Contributing to lograil

Thanks for helping improve `lograil`! This guide covers local setup, the test/lint
gates, and the conventions the project follows.

## Getting started

The project uses **yarn** (Corepack-enforced) on Node `>=18`.

```bash
corepack enable
yarn install
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `yarn test` | Run the Vitest suite once |
| `yarn test:coverage` | Run tests with coverage |
| `yarn bench` | Run the benchmark suite (`vitest bench`) |
| `yarn typecheck` / `yarn typecheck:test` | Type-check `src` and `test` |
| `yarn lint` | ESLint + Prettier-as-lint-rule |
| `yarn format` | Apply Prettier formatting |
| `yarn format:check` | Verify formatting without writing |
| `yarn build` | Emit ESM + CJS builds into `dist/` |
| `yarn docs:dev` | VitePress dev server |
| `yarn changeset` | Record a release note and version bump |

Before opening a PR, make sure `yarn lint`, `yarn typecheck`, `yarn typecheck:test`
and `yarn test` all pass locally.

## Architecture at a glance

```
Core (Logger) -> Pipeline (Filter/Processor/Formatter) -> Transports
        isolated from runtime differences by Runtime Adapters
        extended by Plugins, enriched by Context
```

Source layout (`src/`): `core/`, `pipeline/`, `transport/`, `runtime/`,
`plugin/`, `context/`, plus `types.ts` and the `index.ts` public API. Public
exports live in `src/index.ts` and the `./core`, `./pipeline`, `./transport`,
`./runtime`, `./plugin`, `./context` subpath exports.

Keep the layering intact: `core` must not reach into runtime specifics — those
belong in `runtime/`. Add new public API in `src/index.ts` intentionally.

## Conventions

- **TypeScript** with `strict` on. No `any` where avoidable; use `import type`.
- **Prettier** is enforced via ESLint (`singleQuote`, `semi`, `printWidth: 100`).
  Run `yarn lint` to validate both.
- Prefix intentionally unused variables/args with `_`.
- Add or update **tests** for any behavior you change, including edge cases for
  filters, processors, formatters, transports, runtime adapters and plugins.
- Document new public features under `docs/` (English + Chinese mirror).

## Commit messages

This repo follows [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add per-transport async write queues
fix(transport): guard OTLP flush against empty batch
docs: document immutable entry contract
```

Add a Changeset for each change that should be included in a release.

## Releasing

Releases use Changesets and npm trusted publishing:

1. Run `yarn changeset` in your branch and commit the generated Changeset.
2. After the change reaches `main`, GitHub Actions opens or updates a
   **Version Packages** pull request.
3. Merging that pull request publishes to npm and deploys the latest docs.

The npm package must trust the GitHub Actions publisher configured in
`.github/workflows/release.yml` with the `npm` environment. GitHub Actions must
also be allowed to create pull requests. No npm token is needed; see the
[releasing guide](docs/guide/releasing.md) for setup details.
