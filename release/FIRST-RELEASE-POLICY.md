# 首发渠道与验收结论说明（历史记录）

> 历史范围：以下保留 2026 年 9 月 29 日至首发前的准备口径，不表示当前发布状态。当前已提供 [1.0.1-rc.1 预发布版](https://github.com/denggui-ai/zhaocai-guan/releases/tag/v1.0.1-rc.1)；现行安装与验证范围见 [README](../README.md) 和该版本发行说明。原文中的“尚未发布”等表述仅适用于准备阶段。

生效口径：2026-09-29，沿用[开源决策](../docs/decisions/2026-09-28-open-source.md)。当前为 1.0.1 公开版候选，尚未获负责人发布决定、尚未发布；本说明不构成发布授权。

| 平台或渠道 | 首发范围 |
|---|---|
| macOS Apple Silicon | 允许提供未公证包，当前候选为 ad-hoc 本地签名；须经人工业务、安装验收及负责人明确发布决定 |
| Developer ID 与 Apple 公证 | 后续渠道；选择 `--official` 时仍须全部签名、公证、装订和 Gatekeeper 门禁通过 |
| macOS Intel | 仅源码、未验收，不提供已验证安装包的承诺 |
| Windows x64 | 实验性源码，首发无安装包；本机录音与 ASR 禁用 |
| Linux | 未支持 |

`package:mac:arm64` 生成隔离候选；历史命令 `release:mac:internal` / `--publish` 生成本地未公证归档，名称中的 `internal` 不构成额外发布政策。`release:mac:official` 选择后续公证渠道。这些命令均不上传文件，也不代替负责人对公开仓库、首次推送和 Release 的明确确认。

自动自检的 PASS 只覆盖实际执行的技术检查，`GO WITH CONDITIONS` 是继续验收的建议。公开发布前须按[人工业务验收清单](MACOS-HR-UAT-CHECKLIST.md)和[安装说明](MACOS-README.md)完成验收，核对最终产物与冻结提交、校验和及验收记录，解决阻塞问题，并记录负责人、决定时间和未验证范围。首发安装说明必须保留未公证状态及系统放行方法，不得用本地签名完整性检查或校验和替代 Apple 公证声明。

可选能力按实际证据说明：Swift/Vision、Poppler、SoX、whisper.cpp 和模型的依赖不能由启动 PASS 推断齐全；离线合成自检不证明麦克风、外部 AI、飞书或真实材料准确率。AI 默认关闭、服务地址由使用者配置、材料外发逐次确认；升级需备份整个数据目录，旧 v1 密钥需重新输入和验证，详见[开发与恢复说明](../DEVELOPMENT.md#ai-credential-recovery)。

## 历史自检证据补充说明

2026-09-29 接手验证保存的 `macos-candidate-self-test/summary.md`、`summary.json` 等原始证据不改写。其中“ad-hoc 仅允许内部技术候选”“不得外发”及“正式外发仍需 Developer ID 与 notarization”来自旧发布政策文案，与既定未公证首发范围不一致，发布渠道解释以本说明为准。

这项文案修正不补写任何测试结果，不证明旧候选已通过人工验收或获准发布；原记录中的实际签名状态、技术结果、未测范围及产物身份仍保留。最终产物须使用对应源码重新构建并保留自己的证据，不能把这份补充说明当作旧包已通过新增检查。
