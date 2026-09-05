---
layout: home

hero:
  name: lograil
  text: 通用日志库，覆盖 Web、Node.js 与 Electron
  tagline: 高性能、结构化的日志方案，采用 Core → Pipeline → Transport 的分层架构，可在 Web、Node.js 与 Electron 上无缝运行，并通过插件扩展到其他平台。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: API 参考
      link: /zh/api/
    - theme: alt
      text: GitHub
      link: https://github.com/axetroy/lograil

features:
  - title: 运行时不限
    details: 一套 API 同时支持 Web、Node.js 与 Electron。运行时会自动探测，你也可以传入自定义适配器。
  - title: 默认结构化
    details: 每条日志都是一个带类型的 LogEntry，包含时间戳、作用域、上下文、元数据以及完整的 Error 因果链。
  - title: 可组合管道
    details: 过滤器、处理器与格式化器自由组合，内置脱敏与采样能力。
  - title: 跨运行时一等公民
    details: Web、Node.js 与 Electron 开箱即用，运行时会自动探测——一套 API，无需为不同平台写额外代码。
  - title: 插件可扩展
    details: 插件可在运行时添加传输器、重构管道、拦截日志条目，甚至注册其他插件。实现自定义运行时适配器，即可支持任意其他平台。
  - title: 轻量且类型完备
    details: 使用 TypeScript 编写，同时提供 ESM 与 CJS 构建，基于 MIT 许可，并通过子路径导出支持按需引入。
  - title: 按传输器路由
    details: 每个传输器都可设置自己的级别与格式化器，于是单个 logger 即可分流——例如 error 发往 OTLP，其余写入文件。
  - title: 内置可观测性
    details: 通过 OTLP 把日志发往 OpenTelemetry Collector，并自动关联 traceId/spanId；再配合子 logger 与采样实现成本控制。
  - title: 崩溃安全
    details: 退出时自动 flush、把未捕获异常以 fatal 记录，并将 console.* 桥接进结构化管道。
---

## 项目资源

- **贡献指南** — 本地环境、测试/lint 门禁与规范：
  [CONTRIBUTING.md](https://github.com/axetroy/lograil/blob/main/CONTRIBUTING.md)
- **安全策略** — 如何私下上报安全漏洞：
  [SECURITY.md](https://github.com/axetroy/lograil/blob/main/SECURITY.md)
- **更新日志** — 每次发版由 git 历史自动生成：
  [CHANGELOG.md](https://github.com/axetroy/lograil/blob/main/CHANGELOG.md)
- **迁移指南**（来自 `electron-log` / `winston` / `pino`）：[指南](/zh/guide/migrating)
- **故障排查与 FAQ**：[指南](/zh/guide/troubleshooting)
