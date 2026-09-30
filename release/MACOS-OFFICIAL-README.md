# 招才官 macOS Apple Silicon 正式包说明模板

版本：1.0.1

**本次公开候选尚未发布，也尚未通过正式公证。** 本文件只用于未来正式签名构建，不能作为当前候选已获公证的证据。

本模板对应 `--official` 的 Developer ID 与公证渠道。既定首版允许未公证包，使用 `MACOS-README.md` 的说明并经人工验收和负责人明确决定；不必先切换到本渠道。完整边界见项目源码中的 `release/FIRST-RELEASE-POLICY.md`。

## 适用条件

只有构建实际完成以下所有门禁，本说明才可随该渠道产物分发：使用明确的 `Developer ID Application` 身份签名、启用 Hardened Runtime、应用和 DMG 的 Apple 公证均返回严格的 `Accepted`，完成票据装订与验证，并通过 Gatekeeper 检查。任一步失败，不得生成该渠道的成功声明或冒充已公证产物。

本模板描述的是应满足的条件；实际结果必须由随包构建与验收证据支持。目标仅为 Apple Silicon（arm64），不能替代 Intel 或 Windows 真机验收。

## 安装与校验

取得实际批准的正式包后，DMG 与 ZIP 选择一种下载即可，同时取得同版本校验文件 `__HRBOSS_SHA256SUMS_FILENAME__`。构建器在分发前替换校验文件名，不要求同时下载两种格式。

先计算实际下载文件的 SHA-256。将引号中的示例路径替换为你的文件完整路径；下载 DMG 时使用实际 `.dmg` 路径：

```bash
shasum -a 256 "/完整路径/实际下载的文件.zip"
```

在对应校验文件中找到**名称完全相同**的条目，逐字符核对输出的 64 位 SHA-256；只核对所下载的文件。条目缺失或哈希不一致时停止并核查。核对通过后，将 `招才官.app` 从 DMG 或完整解压的 ZIP 移到“应用程序”。

校验和只证明文件与本次发布记录一致，不能代替签名、公证或来源核验。

## 应随包提供的证据

- 主程序与 SQLite 模块均为 arm64，Bundle ID 为 `io.talentbench.desktop`。
- Developer ID Application 身份、Team ID、Hardened Runtime 和严格签名验证结果。
- 应用与 DMG 分别获得的 Accepted 结果、票据验证和 Gatekeeper 评估。
- 冻结源码、依赖锁文件、隔离构建和纯合成数据启动/退出结果。

## 功能与数据

Poppler、SoX、whisper.cpp 和模型按需另行安装，不假定已包含在应用中。软件检查不证明麦克风权限或真实收音成功。

候选人资料主要保存在本机；可选 AI 和飞书/Lark 导入会在用户授权时访问外部服务。包内不得含业务数据库、材料或密钥。实际使用边界以项目 README 和对应版本发布说明为准。
