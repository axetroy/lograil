# 发布流程

每个准备发布的更改都应包含一个 Changeset。在分支中运行 `yarn changeset`，并将生成的文件与更改一起提交。

Changeset 合并到 `main` 后，GitHub Actions 会创建或更新 **Version Packages** 拉取请求。合并该拉取请求后，工作流会发布 npm 包并部署最新文档。

## 一次性配置

1. 在 npm 包设置中添加 GitHub Actions **Trusted Publisher（可信发布者）**：
   - 所有者：`axetroy`
   - 仓库：`lograil`
   - 工作流文件：`.github/workflows/release.yml`
   - Environment：`npm`
2. 在 GitHub Actions 设置中，允许工作流创建拉取请求。

发布通过 npm 的 OIDC 可信发布完成。不要添加 `NPM_TOKEN` 密钥。
