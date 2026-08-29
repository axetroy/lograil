# 通用高性能安全日志库（Web / Node.js / Electron）

## Executive Summary

本项目旨在构建一个同时适配 **Web、Node.js 与 Electron（主进程 / 渲染进程）环境**的生产级日志库，为桌面应用、浏览器应用与 Node.js 服务端 / CLI 提供统一、高性能、可靠且可扩展的日志基础设施。

核心目标不是简单提供 `console.log` 的封装，而是建立一套具备以下能力的日志系统：

* 统一的跨运行时日志 API
* 高吞吐、低延迟的日志写入路径
* 尽可能避免日志丢失与文件损坏
* Electron 环境下可靠的本地持久化
* Web 环境下适配控制台、远程上报及其他输出目标
* 可插拔的 Transport、Formatter、Filter、Processor 等扩展机制
* 明确的同步/异步边界
* 可观测、可测试、可演进的内部架构
* 对 AI 辅助开发友好的模块化代码与文档边界

整体架构采用 **Core + Runtime Adapter + Pipeline + Transport + Plugin** 的分层模型。

Core 负责稳定的日志模型与生命周期；Runtime Adapter 屏蔽 Electron/Web 运行时差异；Pipeline 负责日志处理；Transport 负责最终输出；Plugin System 为系统提供可扩展能力。

---

## High-Level Architecture Diagram

```text
                         Application
                              │
                              ▼
                    ┌──────────────────┐
                    │   Logger API     │
                    │  Unified Facade  │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │   Log Core       │
                    │ Entry / Context  │
                    │ Level / Metadata │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ Processing       │
                    │ Pipeline         │
                    │                  │
                    │ Filter           │
                    │ Processor        │
                    │ Formatter        │
                    └────────┬─────────┘
                             │
                  ┌──────────┴──────────┐
                  │                     │
                  ▼                     ▼
         ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
         │ Electron Runtime │   │   Web Runtime    │   │   Node Runtime   │
         │ Adapter (main /  │   │   Adapter        │   │   Adapter        │
         │ renderer)        │   │                  │   │                  │
         └────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
                  │                      │                      │
                  ▼                      ▼                      ▼
         ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
         │ File / IPC /     │   │ Console / HTTP / │   │ File / Console / │
         │ Main Process      │   │ Remote Transport │   │ Server Transport │
         └────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘
                 │                      │
                 └──────────┬───────────┘
                            ▼
                    ┌──────────────────┐
                    │ Plugin System    │
                    │ Extensible       │
                    │ Capabilities     │
                    └──────────────────┘
```

---

## Documentation Structure

```text
architecture/
├── README.md
│
├── 01-executive-summary.md
├── 02-background.md
├── 03-design-goals.md
├── 04-architecture-overview.md
│
├── modules/
│   ├── core/
│   ├── runtime/
│   │   ├── electron/
│   │   └── web/
│   ├── pipeline/
│   ├── transport/
│   ├── plugin/
│   └── context/
│
├── interfaces/
│   ├── logger-api.md
│   ├── transport-api.md
│   ├── plugin-api.md
│   ├── configuration.md
│   └── versioning.md
│
├── data/
│   ├── log-entry.md
│   ├── storage-strategy.md
│   ├── serialization.md
│   └── lifecycle.md
│
├── operations/
│   ├── deployment.md
│   ├── performance.md
│   ├── security.md
│   ├── observability.md
│   ├── testing.md
│   └── release.md
│
├── roadmap.md
├── risks.md
└── appendix.md
```

---

## Module Index

| Module     | Responsibility            | Documentation        |
| ---------- | ------------------------- | -------------------- |
| Core       | 定义统一日志模型、Logger 生命周期与核心抽象 | `modules/core/`      |
| Runtime    | 屏蔽 Electron 与 Web 运行时差异   | `modules/runtime/`   |
| Pipeline   | 管理日志处理链路                  | `modules/pipeline/`  |
| Transport  | 将日志输出到不同目标                | `modules/transport/` |
| Plugin     | 提供可扩展插件机制                 | `modules/plugin/`    |
| Context    | 管理上下文、关联信息与运行时元数据         | `modules/context/`   |
| Interfaces | 定义公共 API 与稳定契约            | `interfaces/`        |
| Data       | 定义日志数据模型与生命周期             | `data/`              |
| Operations | 定义性能、部署、安全与运维体系           | `operations/`        |

### Core

统一日志抽象层，是整个系统的稳定基础。

详细设计：

`modules/core/README.md`

### Runtime

负责 Web、Node.js 与 Electron（主进程 / 渲染进程）环境差异隔离。

详细设计：

`modules/runtime/README.md`

### Pipeline

负责从日志产生到输出之间的处理流程。

详细设计：

`modules/pipeline/README.md`

### Transport

负责不同日志目标的输出能力。

详细设计：

`modules/transport/README.md`

### Plugin

负责扩展日志库能力，同时控制插件生命周期与兼容边界。

详细设计：

`modules/plugin/README.md`

### Context

负责请求、用户操作、窗口、进程等关联上下文。

详细设计：

`modules/context/README.md`

---

## Reading Guide

### 产品与架构决策

建议阅读：

```text
README.md
  ↓
01-executive-summary.md
  ↓
02-background.md
  ↓
03-design-goals.md
  ↓
04-architecture-overview.md
```

用于理解项目为什么存在、解决什么问题以及整体架构如何划分。

### Core 开发

建议阅读：

```text
04-architecture-overview.md
  ↓
modules/core/README.md
  ↓
interfaces/logger-api.md
  ↓
data/log-entry.md
```

### Electron 开发

建议阅读：

```text
04-architecture-overview.md
  ↓
modules/runtime/README.md
  ↓
modules/runtime/electron/
  ↓
modules/transport/
```

### Web 开发

建议阅读：

```text
04-architecture-overview.md
  ↓
modules/runtime/README.md
  ↓
modules/runtime/web/
  ↓
modules/transport/
```

### Plugin 开发

建议阅读：

```text
modules/plugin/README.md
  ↓
interfaces/plugin-api.md
  ↓
modules/pipeline/
  ↓
modules/transport/
```

### 性能与可靠性

建议阅读：

```text
03-design-goals.md
  ↓
04-architecture-overview.md
  ↓
operations/performance.md
  ↓
data/storage-strategy.md
```

---

## Document Dependency Overview

```text
                         README
                           │
                           ▼
                01-executive-summary
                           │
                           ▼
                    02-background
                           │
                           ▼
                    03-design-goals
                           │
                           ▼
                04-architecture-overview
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
        Core            Runtime          Pipeline
          │                │                │
          │          ┌─────┴─────┐          │
          │          ▼           ▼          │
          │      Electron       Web         │
          │          │           │          │
          └──────────┼───────────┼──────────┘
                     │           │
                     └─────┬─────┘
                           ▼
                       Transport
                           │
                           ▼
                        Plugin
                           │
                           ▼
                      Interfaces
                           │
                           ▼
                          Data
                           │
                           ▼
                      Operations
```

文档依赖遵循**由抽象到实现、由稳定层到扩展层**的方向：

* `README.md` 只负责导航。
* Executive Summary / Background / Goals 描述问题与设计依据。
* Architecture Overview 描述系统边界与模块关系。
* Modules 描述独立模块。
* Interfaces 描述跨模块稳定契约。
* Data 描述数据模型与持久化相关概念。
* Operations 描述生产环境要求。
* Roadmap / Risks / Appendix 描述演进与辅助信息。

具体 API、数据结构、状态机、写入算法、缓存策略、文件一致性策略、插件生命周期等实现细节均不在 README 中展开，而应放置于对应的子文档。

---

## Depends On

无。

这是整个架构白皮书的根文档。

Referenced By

无。

## Child Documents

* `01-executive-summary.md`
* `02-background.md`
* `03-design-goals.md`
* `04-architecture-overview.md`
* `modules/`
* `interfaces/`
* `data/`
* `operations/`
* `roadmap.md`
* `risks.md`
* `appendix.md`
