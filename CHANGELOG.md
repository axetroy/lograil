# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This file is generated from git history by `scripts/gen-changelog.mjs` (run via `yarn changelog`) and refreshed automatically on each release.

## [v0.1.6] - 2026-10-16

- 0.1.6
- Harden logging dispatch, processing, and runtime boundaries (#9)

## [v0.1.5] - 2026-10-13

- fix(tsconfig): add DOM lib to test config for browser API tests
- 0.1.5
- test: add deep coverage tests for OS-native, runtime, and IPC transports
- docs: add volume-control / sampling section to architecture guide (P3-2)
- feat: add BroadcastChannelTransport for cross-tab Web streaming (P3-1)
- docs: document WorkerIpcTransport and ClusterIpcTransport (P2-1)
- feat: add OS-native transports (syslog, journald, Windows Event Log)
- feat: add a level registry for user-defined levels (registerLevel)
- docs: document child context snapshot semantics; add regression test
- refactor: make main->peer level sync manual (broadcastLevelToPeers)
- feat: wire bidirectional cross-process level sync; auto-restore console on destroy
- docs: sync docs with P1/P2 fixes and correct stale defaults
- fix(worker-ipc): save/restore pre-existing worker.onmessage handler (P2-13)
- fix(console): guard module-load console binding against missing global (P2-12)
- fix(logger): replace same-name transport instead of double-writing (P2-11)
- fix(otlp): bound failed-batch re-send work to two flush cycles (P1-10)
- fix(logger): drain promise must not be replaced mid-batch (P1-9)
- fix(serialize): prevent Object.prototype pollution via __proto__ keys (P1-8)
- chore: remove unused eslint-disable directive in electron.ts
- fix: normalize W3C trace/span ids in otel-trace plugin
- fix: electron before-quit/will-quit flush runs exactly once
- fix: plugin onEntry receives a shallow snapshot so in-place mutation+throw cannot leak
- fix: pipeline drop-signal is null/undefined, not any falsy value
- fix: web worker detection covers Deno/Bun/shared workers and Node worker_threads
- fix: isMainProcess requires process.versions.electron before trusting main
- fix: process-lifecycle signal handler distinguishes flush-confirmed from flush-timed-out exit
- fix: circuit breakers still attempt delivery while open so IPC channels can recover
- fix: add circuit breakers to cluster/worker/electron IPC transports when peer is gone
- fix: OTLP re-queues undelivered batches so close() retries instead of losing them
- fix: TruncateRotator retries rm/rename to survive NTFS delayed-delete on Windows
- fix: add bufferedBytes API to FileIo for accurate size accounting in rotators
- fix: sampler token bucket now uses wall-clock time, immune to regressing timestamps
- fix: redaction now safe against prototype pollution; walks Map/Set
- fix: OtlpTransport flush() awaits in-flight batches instead of no-op-ing
- fix: FileTransport flush() now surfaces write failures instead of always resolving
- fix: transport queue depth now tracks in-flight writes and re-opens after settle
- fix: restrict entry.error to Error instances and document singleton context
- docs: 添加单例 logger 约束警告
- test: 添加 electron 绑定回退、文件错误回退和运行时检测的测试
- docs: deduplicate homepage feature cards and clarify Chinese copy (#8)
- docs: 更新 FileTransport 示例以使用新配置参数
- feat(file): change FileTransport default formatter from JSON to line
- feat(otlp): add queue overflow backpressure (maxQueueSize, onQueueOverflow)
- feat: 为文件传输添加 onError 错误报告机制，支持回调监控非致命文件系统错误
- refactor: 将文件旋转逻辑抽取到独立模块
- feat: 添加安全模式支持，自动脱敏常见敏感信息，增强日志安全性 close #7
- feat: 添加最大重试次数和退避延迟配置，增强 OtlpTransport 的错误处理能力 close #6
- feat: 添加最大异步写入队列深度限制，防止内存无限增长 close #5
- feat: 当无法确定 appName 时优雅降级为仅控制台输出，避免在 REPL/无服务器/嵌入式环境中崩溃, close #4
- feat: 重构 IPC 接收器以支持多订阅者扇出 close #3

## [v0.1.4] - 2026-09-04

- chore: 在 package.json 补充 repository、homepage 与 bugs 元信息
- 0.1.4
- ci: 升级 actions/setup-node 至 v6，发布环境改用 Node 24 并简化 npm publish

## [v0.1.3] - 2026-09-04

- 0.1.3
- docs: 在 AGENTS.md 新增类型检查章节，记录 typecheck 双命令与常见测试类型陷阱
- fix: 修复测试类型定义与 OpenTelemetry 类型路径

## [v0.1.2] - 2026-09-04

- 0.1.2
- ci: 移除 Publish 步骤的 NODE_AUTH_TOKEN，改用 npm OIDC 可信发布
- test: 补充 PluginContext 移除 transport/卸载插件与 setOnLevelCommand 回调接线的用例
- fix: 处理缺失 Electron 二进制时的错误，返回最小存根以避免运行时崩溃
- fix: 安全审计修复 8 个隐患问题，补充 10 个回归测试
- fix: add global deduplication for cluster/worker/electron IPC receivers
- chore: remove zero-copy IPC path from ElectronIpcTransport and update docs
- feat: 添加 log 方法作为 info 的别名
- fix: inject ipcRenderer explicitly in createElectronRuntime renderer path
- fix: remove invalid buffer transfer arg from electron postMessage calls
- chore: bump @opentelemetry/api peer dependency to ^1.9.1 and simplify dynamic import
- Optimize sampler, console, and context for performance improvements (#2)

## [v0.1.1] - 2026-09-02

- 0.1.1
- test: increase timeout for single mode capacity caps no-op test
- docs: add Glossary page and clarify key terms in guides
- docs: add per-transport level filtering, clarify scope vs child, fix plugin immutability
- refactor: rename namespace options to scope for consistency
- docs: add Context & Metadata guide and cross-link across docs
- feat: accept non-Error values as error in log entries
- test: add coverage tests for serialize processors and jsonFormatter, simplify vitest config
- ci: simplify docs deploy to latest root only, drop versioned docs and versions.json
- ci: use orphan commits for docs branch deployments
- Harden logging pipeline edge cases: OTLP flush drain, rotation semantics, plugin rollback, and transport teardown (#1)
- test: add braces to arrow function callback in signal handler test
- test: add integration tests for Node runtime cluster and worker_threads
- test: add coverage for edge cases in printf, formatter, pipeline, serializer, and sampler
- test: add coverage for edge cases in formatter, lifecycle, processor, and runtime
- test: add integration tests for LiveTransport replay/buffer and Logger.destroy edge cases
- test: add process handler cleanup and fix LiveTransport buffer validation
- fix: properly restore previous onmessage handler and add close to WorkerIpcTransport
- perf: replace unbounded dispatch promise chain with bounded inflight counter
- perf: cache namespace filters and share mutable path in redactNode
- docs: translate pronunciation guide to English
- docs: add pronunciation guide for lograil
- fix: correct GitHub repo name in logo URL from electron-logger to lograil
- fix: update logo image URL to GitHub raw link in README.md
- chore: update logo SVG design to train wheel motif

## [v0.1.0] - 2026-09-01

- chore: add author field to package.json
- test: remove unused LOG_LEVELS import and _entry helper
- feat(core): getLevel() returns peer level for cross-process consistency
- feat(transport): add cross-process log level sync via IPC
- feat(transport): add FileTransport file inspection API and tests
- test: align write calls with updated Transport interface signature
- fix(electron-ipc,core): surface IPC transport errors and guard flush against stalls
- refactor(transport): align write signatures with Transport interface
- docs: enable Mermaid support in VitePress docs
- docs(plugins): expand lifecycle docs with flow diagrams and error handling
- feat(worker-threads): add automatic log forwarding from workers to main thread
- feat(node): add cluster support with automatic worker-to-primary log forwarding
- docs: add runtime-specific guides and update navigation
- docs(FileTransport): document name option semantics
- refactor(FileTransport): remove custom fileName option from rotate-size and rotate-time modes
- feat(runtime): apply disk-safety defaults to default file transports and add maxFilesPerBucket cap
- feat(FileTransport): split rotate-time buckets by maxSize and trim maxFiles by time bucket
- docs: document browser bundling and web runtime usage
- fix(test): ensure dist directory exists before writing browser bundle
- feat(shims): add browser-compatible Node API shims and enforce their use
- fix(FileTransport): clarify maxAge semantics, track owned files, and suppress repeated write errors
- feat(FileTransport): add global capacity caps (maxTotalSize / maxAge) with throttled checks
- feat(runtime): move Electron log dir to app.getPath('logs'), allow dir override
- refactor(FileTransport): split 5 modes into isolated Rotator strategies
- fix(FileTransport): harden single-truncate on Windows and resume rotate-time ring on restart
- feat: replace RotatingFileTransport with unified FileTransport (5 modes, appName required)
- docs: reposition as universal logging library with Web/Node/Electron as first-class runtimes, plugins for other platforms
- docs: document runtime lifecycle hooks and Electron app quit events
- feat: wire runtime lifecycle hooks and cover Electron app quit events
- ci(test): harden verify.yml, lift coverage past 90% and fix otel-trace crash
- feat: lightweight child/scope loggers and printf-style message formatting
- perf: eliminate per-call allocations on hot path and fix transport queue leak
- style(theme): flatten version map
- fix(core): flush logs on exit with timeout safety
- docs(agents): add documentation wording guidelines
- docs(guide): add Introduction chapter covering what/why/when and core concepts
- docs(transport): restructure LiveTransport guide into entity vs formatted-string rendering
- fix(test): close loggers before removing temp dir in node-file integration
- feat(transport): add LiveTransport for in-process log streaming
- fix(ci): pass boolean input only on workflow_dispatch
- ci: add coverage thresholds and CI coverage gate
- test: 新增分层集成测试（Node 落盘 / Web jsdom / Electron 真实 IPC）
- docs: 用更口语化的措辞重写文档术语
- docs: 补充项目文档并修正迁移/排查表述
- fix(docs): 更新 GitHub 链接以指向正确的仓库
- feat: define immutable LogEntry contract and zero-copy IPC transfer
- feat(logger): 添加异步插件拦截顺序处理，确保传输队列独立，避免阻塞
- feat: add P1 features (stderrLevels, JSON flatten, serializer/redact presets, env level & namespace filter, OTel trace plugin)
- feat(logger): 添加全局错误处理和超时机制，确保内部错误不会导致调用方崩溃
- feat(docs): 更新文档以添加新功能和示例，包括上下文导出、传输器过滤器和生产模式示例
- feat(sampler): 添加采样器以降低日志量，支持概率采样和限速策略
- feat(logger): 添加子 logger 支持，合并上下文并允许级别覆盖 feat(otlp): 映射 traceId/spanId 上下文到 OTLP 追踪字段 test: 添加子 logger 和 OTLP 传输器的单元测试
- feat(transport): 添加 onError 钩子以处理写入失败的情况
- feat(transport): 添加 OtlpTransport 以支持通过 OTLP HTTP/JSON 转发日志
- feat(processor): 添加序列化处理器以在格式化前归一化值
- feat(transport): add optional minimum level for transports to filter log entries
- feat(core): add crash capture, console bridge and exit auto-flush
- feat(context): ambient async context via AsyncLocalStorage with browser no-op
- feat(redact): support path/wildcard redaction over context, metadata and args
- test: 更新日志文件名称检查以确保包含 Lograil 和文件类型
- feat: 更新 Electron 运行时以支持主进程和渲染进程的独立日志文件
- feat: 增加 logo
- feat: refactor CI and release workflows to use a shared verification pipeline
- test: increase timeout for daily log rotation test
- chore: add lint:fix and format scripts to package.json
- fix: update GitHub token reference in workflows for docs deployment
- feat: add release workflow for versioned publishing and docs deployment
- feat: add AGENTS.md for AI coding agent guidance and project setup
- docs: update repository references from electron-logger to lograil
- chore: update electron dev deps
- feat: add .gitattributes for consistent line endings and binary file handling
- feat: init
- Create README.md

[v0.1.0]: https://github.com/axetroy/lograil/compare/v0.1.0...v0.1.0
[v0.1.1]: https://github.com/axetroy/lograil/compare/v0.1.0...v0.1.1
[v0.1.2]: https://github.com/axetroy/lograil/compare/v0.1.1...v0.1.2
[v0.1.3]: https://github.com/axetroy/lograil/compare/v0.1.2...v0.1.3
[v0.1.4]: https://github.com/axetroy/lograil/compare/v0.1.3...v0.1.4
[v0.1.5]: https://github.com/axetroy/lograil/compare/v0.1.4...v0.1.5
[v0.1.6]: https://github.com/axetroy/lograil/compare/v0.1.5...v0.1.6
