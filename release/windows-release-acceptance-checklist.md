# 招才官 Windows x64 技术验收清单

版本：1.0.1。当前为实验性源码，首发没有 Windows 安装包；本清单仅供后续获得授权的技术候选验证。未执行的步骤填 NOT RUN 或 BLOCKED，不填写 PASS。

## 自动检查

取得完整候选并核对来源后，在实际 Windows x64 测试机中使用隔离合成数据：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File ".\release\windows-release-self-test.ps1" `
  -PackagePath ".\app" `
  -EvidenceRoot ".\windows-acceptance-evidence"
```

该命令不修改系统全局执行策略。正式签名候选还需 `-RequireAuthenticode`；未签名技术包不能据此宣称签名通过。

检查应覆盖 PE x64 主程序和 SQLite 模块、包内敏感文件排除、仅回环服务、隔离数据库跨重启持久化、文件 ACL 和退出后的进程清理。脚本不访问真实麦克风，不将真实外部服务作为离线验证的一部分。

## 人工检查

- [ ] 记录 commit、版本、系统、候选哈希和自动结果。
- [ ] 合成岗位→简历文件导入→人工核对→规则评级→面试记录→人才库路径可用。
- [ ] 缺少 Poppler/Tesseract 时提示可理解；安装文档工具不误导为截图支持。
- [ ] 本地录音和 ASR 显示禁用；未经授权的外部 AI 不发送材料。
- [ ] 若另获 AI 实测授权，逐图检查外发预览、确认、取消与错误恢复，仅用合成图片。
- [ ] 升级前执行整个数据目录备份；验证恢复材料、任务与数据库的一致性。
- [ ] 记录真实安装、卸载、签名与 SmartScreen 结果，不从无头 CI 推断。

公开版没有招聘平台账号通道，不恢复登录、同步或抓取作为验收步骤；不得为了测试主动制造真实 `code=36`。

首轮结论上限为 `GO WITH CONDITIONS`，技术 PASS 不授权公开分发。出现数据错配、未批准外发或进程残留时停止，保留合成证据；涉及安全问题时按项目源码或仓库页面中的 `SECURITY.md` 获取私下报告渠道。
