# Windows x64 技术候选构建

适用于 1.0.1 公开版候选。Windows 当前实验性源码、首发无安装包；保留此入口供后续受控技术验证，不表示现在已能正式分发。

在源码根目录执行：

```bash
node release/build-windows-candidate.js
```

构建器先运行完整 `npm run verify`，再运行 Forge、检查 PE x64 主程序及 SQLite 模块、扫描候选文件并生成哈希和 manifest。默认 Forge 输出在 `dist/`，技术候选在 `dist/windows-candidates/`。构建结果包含源码 commit、工作区状态及哈希；不将脏工作区冒充干净提交。

生成物使用 `ZhaocaiGuan.exe` 与 `START-ZhaocaiGuan.cmd`；manifest 明确记录 `production_release_allowed = false`、`signing_state = unsigned-candidate` 和尚未取得的真机结果。没有跳过验证的参数。

本地契约检查使用临时合成 PE 文件，不启动应用：

```bash
node check-suite-runner.js files check-windows-candidate-contract.js
```

后续实际候选仍须在 Windows x64 真机完成 [验收清单](windows-release-acceptance-checklist.md)。本地录音与 ASR 当前禁用，招聘平台账号通道已删除，不应为了凑齐历史验收项重新启用。签名、安装/卸载、备份恢复和当前支持功能需要实际证据。

任何构建成功都不构成公开发布授权。保留的历史发布证据工具另有不适用于当前候选的前提，见 [说明](WINDOWS-RELEASE-READINESS.md)。
