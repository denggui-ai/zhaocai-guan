# Windows 发布证据工具的适用范围

**当前 1.0.1 公开版候选不发布 Windows 包。** `build-windows-release-readiness.js` 是保留的历史证据一致性工具，不是当前公开候选的发布入口，也不能单独授权发布。

## 为什么当前不能用它宣告就绪

工具仍要求上一稳定正式版、干净提交、签名候选、完整回滚备份及联合批准证据，并保留历史 `MIC_ASR`、`BOSS_LIMITED` 等验收项。公开版已禁用 Windows 本地录音/ASR、移除招聘平台账号通道，这些旧前提与当前产品范围不一致。

不得伪造 PASS、重建已剥离的平台通道，或删除门禁来通过这份历史工具。未来设计 Windows 正式发布流程时，应先审查并更新代码契约、验收范围和首版基线，再获得实际证据。

## 工具目前能检查什么

它比较已有 manifest、受测 `ZhaocaiGuan.exe`、分发物、Authenticode 证据、数据备份和审批记录的格式及哈希。不执行签名，不需要或读取签名私钥，不提供自动更新。Windows 的签名采集脚本只记录公开签名状态和文件哈希。

即使格式检查全部通过，结果仍保留：

- `production_release_allowed = false`
- `manual_go_no_go_required = true`
- `distribution_payload_binding = UNVERIFIED_EXTERNAL`

可信的真实验收、审批身份及分发物与受测 payload 的绑定仍需外部证据。不存在由 JSON 文件自动获得的发布许可。

## 当前开发者应做什么

使用 [源码启动说明](../DEVELOPMENT.md) 和 [技术候选构建](WINDOWS-CANDIDATE-BUILD.md)，以合成数据记录实际支持能力。按 [Windows 验收清单](windows-release-acceptance-checklist.md) 报告未验证项；不要向用户提供名为正式版的 Windows 下载。
