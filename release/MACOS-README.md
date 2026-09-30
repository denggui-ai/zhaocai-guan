# 招才官 macOS Apple Silicon 本地候选包

版本：1.0.1

当前状态：公开版候选，尚未发布。本文件是随包说明模板，不证明本次构建已经完成。仅适用于 Apple Silicon（arm64）；首轮验收结论上限为 `GO WITH CONDITIONS`。

既定首版允许未公证包：完成人工业务与安装验收、记录未验证范围后，由负责人针对最终产物明确决定是否发布。Developer ID 签名与 Apple 公证属于后续渠道，不是这次首发的统一前置条件。自动自检通过不等于发布获批；完整渠道边界见项目源码中的 `release/FIRST-RELEASE-POLICY.md`。

## 安装与校验

后续取得本地候选后，先完成下面的文件校验，再完整解压 ZIP 或打开 DMG，将 `招才官.app` 放入“应用程序”。不要在压缩软件预览窗口运行。

DMG 与 ZIP 选择一种下载即可，同时取得对应版本的校验文件 `__HRBOSS_SHA256SUMS_FILENAME__`。构建器会在随包说明中替换这个校验文件名；不需要为校验下载另一种应用格式。

在终端计算**实际下载的那个文件**的 SHA-256。将下面引号中的示例路径替换为你的文件完整路径；下载 DMG 时使用实际 `.dmg` 路径：

```bash
shasum -a 256 "/完整路径/实际下载的文件.zip"
```

打开对应校验文件，找到与所下载文件**名称完全相同**的那一行，逐字符核对命令输出的 64 位 SHA-256。只有文件名与哈希均一致才继续；缺少对应条目或不一致时停止并核查。校验文件可能同时列出 DMG 和 ZIP，只需核对你下载的文件。

候选使用 ad-hoc 本地签名，未获得 Developer ID 正式身份与 Apple 公证。确认来源可信后，尝试打开，再到系统设置的“隐私与安全性”选择“仍要打开”，详见 [Apple 指引](https://support.apple.com/en-au/102445)。不要关闭全局安全保护。

校验和用于比对已取得的发布记录，不证明发布者身份或应用已获 Apple 公证。Intel 仅源码、未验收；Windows x64 为实验性源码，首发无安装包且本机录音/ASR 禁用；Linux 未支持。

## 构建必须证明的范围

实际构建证据应证明主程序和 SQLite 原生模块均为 arm64、Bundle ID 为 `io.talentbench.desktop`、签名完整性检查通过，并附带隔离数据目录的启动、退出和持久化检查。未完成的项目记录为未验证，不能仅凭本说明宣称通过。

先按同目录的 [合成数据验收清单](MACOS-HR-UAT-CHECKLIST.md) 验证岗位、简历与截图草稿人工确认流程。纯合成离线验收不证明真实材料准确率、外部服务兼容性或其他平台可用性。

## 本地依赖

截图 OCR 使用系统 Vision，但本版通过 `/usr/bin/swift` 执行识别脚本，需有效的 Xcode 命令行工具或完整 Xcode；应用不附带 Swift 工具链。尚未安装时可按 [Apple 官方说明](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools) 使用 `xcode-select --install`，之后检查 `/usr/bin/swift --version`。

PDF 功能需要 Poppler；本地录音与转写需要 SoX、whisper-cli 和模型，这些不随应用打包。在已安装 Homebrew 的 Mac 上可执行 `brew install poppler sox whisper.cpp`。默认模型放在 `~/.cache/whisper.cpp/ggml-base.bin`，可用 `WHISPER_CPP_MODEL` 覆盖；模型获取参见 [whisper.cpp 官方项目](https://github.com/ggml-org/whisper.cpp)。

“检查软件依赖”不访问麦克风，也不等于已获得系统权限；真实收音需要使用者主动执行麦克风测试。候选包不包含真实候选人数据库、录音、转写或密钥。

## 数据与后续使用

运行数据保存在用户本机目录，实际路径在设置页查看。AI 默认关闭；批准外发时会把选定材料发送到用户配置的服务。可选飞书/Lark 妙记导入也会联网。升级前退出应用并备份整个数据目录及外置数据库、面试等材料；同机恢复时保留受损副本，把同一批次的整套备份恢复到记录的原绝对路径并保留原启动设置。完整步骤见配套源码 `docs/GETTING_STARTED.md` 的“业务资料备份、恢复与升级”。

第一次使用可从配套源码的 `docs/examples/` 取得虚构 JD、画像参考和两份 TXT 简历，按 `docs/GETTING_STARTED.md` 完成启用 JD、确认画像和人工建档；样例不需要 AI、录音或平台账号。它们是试用材料，不是已完成包内验收的证明。

需要开发时使用源码目录，不从 `.app` 中直接修改；完整功能、依赖与源码说明见项目的 `README.md` 和 `DEVELOPMENT.md`。
