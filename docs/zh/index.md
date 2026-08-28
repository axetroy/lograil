---
layout: home

hero:
  name: lograil
  text: 为 Electron 与 Web 打造的安全日志库
  tagline: 高性能、结构化的日志方案，采用 Core → Pipeline → Transport 的分层架构，可在 Web、Node.js 与 Electron 上无缝运行。
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
  - title: 原生支持 Electron
    details: 渲染进程的日志通过 IPC 转发到主进程，并持久化到滚动文件，无需额外接线。
  - title: 插件系统
    details: 插件可在运行时添加传输器、重构管道、拦截日志条目，甚至注册其他插件。
  - title: 轻量且类型完备
    details: 使用 TypeScript 编写，同时提供 ESM 与 CJS 构建，基于 MIT 许可，并通过子路径导出支持按需引入。
---
