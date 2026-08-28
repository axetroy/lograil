---
layout: home

hero:
  name: lograil
  text: Secure logging for Electron & Web
  tagline: High-performance, structured logging with a layered Core → Pipeline → Transport architecture that runs unchanged on Web, Node.js and Electron.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: API Reference
      link: /api/
    - theme: alt
      text: View on GitHub
      link: https://github.com/axetroy/electron-logger

features:
  - title: Runtime agnostic
    details: One API for Web, Node.js and Electron. The runtime adapter is auto-detected, or you can pass your own.
  - title: Structured by default
    details: Every entry is a typed LogEntry with timestamp, scope, context, metadata and full Error cause chains.
  - title: Pluggable pipeline
    details: Filters, processors and formatters compose freely. Redaction and sampling ship out of the box.
  - title: Electron ready
    details: Renderer logs are forwarded to the main process over IPC and persisted to a rotating file — no extra wiring.
  - title: Plugin system
    details: Plugins can add transports, reshape the pipeline, intercept entries and register other plugins at runtime.
  - title: Tiny & typed
    details: Written in TypeScript, ESM + CJS dual build, MIT licensed, with subpath exports for tree-shaking.
  - title: Per-transport routing
    details: Each transport can set its own level and formatter, so one logger fans out — e.g. errors to OTLP, everything to a file.
  - title: Observability built in
    details: Ship logs to an OpenTelemetry Collector via OTLP with traceId/spanId correlation, plus child loggers and sampling for cost control.
  - title: Crash-safe
    details: Flush on exit, capture uncaught errors as fatal, and bridge console.* into the structured pipeline.
---
