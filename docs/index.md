---
layout: home

hero:
  name: lograil
  text: Universal logging for Web, Node.js & Electron
  tagline: High-performance, structured logging with a layered Core → Pipeline → Transport architecture that runs unchanged on Web, Node.js and Electron — and extends to other platforms through plugins.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: API Reference
      link: /api/
    - theme: alt
      text: View on GitHub
      link: https://github.com/axetroy/lograil

features:
  - title: Runtime agnostic
    details: One API for Web, Node.js and Electron. The runtime adapter is auto-detected, or you can pass your own.
  - title: Structured by default
    details: Every entry is a typed LogEntry with timestamp, scope, context, metadata and full Error cause chains.
  - title: Pluggable pipeline
    details: Filters, processors and formatters compose freely. Redaction and sampling ship out of the box.
  - title: First-class runtimes
    details: Web, Node.js and Electron are supported out of the box with auto-detected adapters — one API, no per-platform code.
  - title: Extensible via plugins
    details: Plugins add transports, reshape the pipeline, intercept entries and register other plugins at runtime. Bring your own runtime adapter to support any other platform.
  - title: Tiny & typed
    details: Written in TypeScript, ESM + CJS dual build, MIT licensed, with subpath exports for tree-shaking.
  - title: Per-transport routing
    details: Each transport can set its own level and formatter, so one logger fans out — e.g. errors to OTLP, everything to a file.
  - title: Observability built in
    details: Ship logs to an OpenTelemetry Collector via OTLP with traceId/spanId correlation, plus child loggers and sampling for cost control.
  - title: Crash-safe
    details: Flush on exit, capture uncaught errors as fatal, and bridge console.* into the structured pipeline.
---

## Project resources

- **Contributing** — setup, test/lint gates and conventions:
  [CONTRIBUTING.md](https://github.com/axetroy/lograil/blob/main/CONTRIBUTING.md)
- **Security** — how to report vulnerabilities privately:
  [SECURITY.md](https://github.com/axetroy/lograil/blob/main/SECURITY.md)
- **Changelog** — generated from git history on each release:
  [CHANGELOG.md](https://github.com/axetroy/lograil/blob/main/CHANGELOG.md)
- **Migrating** from `electron-log` / `winston` / `pino`: [guide](/guide/migrating)
- **Troubleshooting & FAQ**: [guide](/guide/troubleshooting)
