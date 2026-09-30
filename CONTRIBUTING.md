# 参与贡献

感谢你愿意改进 招才官 · Zhaocai Guan。当前为 **1.0.1 公开版候选，未发布**，优先欢迎合成数据缺陷复现、安装文档修正和 Windows 源码体验反馈。

## 产品边界

本项目是本地招聘工作台，不接受自动登录或抓取招聘平台、自动联系候选人、自动淘汰或自动录用的改动。规则与分析必须可供 HR 核对，AI 不能替人作出招聘决定。

可以改进用户主动配置并逐次批准的外部 AI、授权的飞书/Lark 妙记导入；不得静默外发材料、上传到维护者服务器或将本地资料用于无关目的。

## 准备环境

下载本仓库源码并进入根目录。准备 Node.js ≥22 和 npm；macOS 另需 Xcode 命令行工具。

```bash
npm ci
npx --no-install electron-rebuild -f -w better-sqlite3
npm run ui
```

Electron 固定为 42.5.1。SQLite ABI 不匹配时重新执行 `electron-rebuild`，不要改用 `npm rebuild better-sqlite3`。环境细节见 [DEVELOPMENT](DEVELOPMENT.md)，平台限制见 [README](README.md)。

## 报告与提交

- Issue 写清版本、系统、最小操作步骤、预期和实际结果。日志与截图只包含合成资料，不含 API Key、令牌、姓名、电话或真实简历。
- 安全问题按 [SECURITY](SECURITY.md) 私下报告，不在公开 Issue 贴复现载荷或敏感细节。
- 变更保持范围集中；说明行为变化、验证命令和仍未验证的部分。
- 测试使用合成数据；未来日期动态生成，避免固定时间到期。
- 提交前运行相关检查及 `npm run verify`。平台真机未验证就如实标记，不从 CI 结果推定可用。
- 依赖变化后执行 `node release/generate-third-party-notices.js` 并审阅生成声明；发布源码扫描按 [开发指南](DEVELOPMENT.md) 在干净归档目录使用 `gitleaks dir . --redact`。

提交信息可采用 `feat:`、`fix:`、`docs:` 等 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 类型。代码注释以英文为主，界面和使用文档使用清晰中文。

社区交流遵循 [行为准则](CODE_OF_CONDUCT.md)。提交贡献即表示你有权提供该内容，并同意按项目 [AGPL-3.0](LICENSE) 授权。
