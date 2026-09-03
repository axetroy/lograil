# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This file is generated from git history by `scripts/gen-changelog.mjs` (run via `yarn changelog`) and refreshed automatically on each release.

## [Unreleased] - 2026-08-29

- fix(docs): 更新 GitHub 链接以指向正确的仓库
- feat: define immutable LogEntry contract and structured-cloning IPC transfer
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

