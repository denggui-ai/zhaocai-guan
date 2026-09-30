# 招才官 开发指南

本文适用于 **1.0.1 公开版候选，未发布**。日常安装与操作见[用户指南](docs/GETTING_STARTED.md)，平台支持和材料外发边界见 [README](README.md)。

## 环境与启动

下载本仓库源码，进入含 `package.json` 的根目录。需要 Node.js ≥22、npm，以及原生模块所需的编译工具；本次维护环境使用 Node.js 26，但不代表所有平台已验证。macOS 需 Xcode 命令行工具。Electron 锁定 42.5.1。

```bash
npm ci
npx --no-install electron-rebuild -f -w better-sqlite3
npm run ui
```

根安装脚本会继续安装 `frontend/` 与 `electron-spike/` 的锁定依赖。`npm run ui` 先构建前端，再启动 Electron。`electron-spike/` 只提供源码启动所需的 Electron 运行时。

`better-sqlite3` 必须使用 Electron ABI。出现 `NODE_MODULE_VERSION` 错误时，重新执行上面的 `electron-rebuild`，不要用面向系统 Node 的 `npm rebuild better-sqlite3`。不应为修复开发环境复制已有业务数据库或凭据。

## 检查

```bash
npm run verify
```

完整门禁包含安全与功能静态契约、后端、合成界面检查及前端构建。耗时取决于机器和可用工具；命令成功不能代替真机人工验收。

定位单项回归时可通过统一运行器选择已有检查，由它为原生模块选择匹配的运行时：

```bash
node check-suite-runner.js files check-release-security.js
npm run build:web
```

检查可能需要监听 `127.0.0.1`；若受运行沙箱限制，应明确记录限制，而不是删除断言。所有自动化证据使用临时合成资料，禁止用真实候选人、真实账号或付费请求冒充离线检查。

### GitHub Actions 的覆盖范围

[Core check](.github/workflows/core-check.yml) 配置在标准 `ubuntu-24.04` 与 `macos-15` runner 上使用 Node 22，运行 18 项离线核心检查和前端构建。macOS 另跑启动器/单实例契约；Linux 明确跳过该项，只作为无头测试环境，不代表支持 Linux 桌面安装。检查使用合成材料、模拟 AI/安全存储与临时 SQLite；PDF 恢复检查注入工具，不依赖开发者本机的 Poppler、Swift 或语音模型。截图拼合子检查在缺少 Python/Pillow 时会打印跳过原因。

[Windows check](.github/workflows/windows-check.yml) 保留 ACL/SQLite 与截图核心检查；全量普查继续为非阻塞信息，不可将工作流的绿色状态解读为全部用例通过。两份工作流只需要 `contents: read`，不需要签名密钥、AI 账号或付费服务，也不会自动发布。标准公共仓库 runner 不使用付费的 larger runner；若在私有仓库启用，先核对该账号 Actions 额度与费用设置。

这些配置尚待首次 GitHub 实际运行验证。它们不执行完整 `npm run verify`、真实 Electron 界面、干净安装、打包、系统钥匙串、OCR/录音或真实服务验收；发布仍须执行下文门禁。首次公开推送后记录各平台的实际结果与显式跳过项，再选择确已通过的作业作为分支保护必需检查。

依赖或锁文件变化后，更新第三方声明与许可证库存：

```bash
node release/generate-third-party-notices.js
```

检查生成的 [声明](THIRD_PARTY_NOTICES.md)、[许可证文本](THIRD_PARTY_LICENSES.txt) 和 [依赖库存](docs/third-party-dependencies.json)。发布前对干净提交执行 `git archive` 并解包，在该源码快照目录运行 `gitleaks dir . --redact`，避免把 `node_modules/` 或运行数据当作发布源码；保留项目 `.gitleaks.toml` 的精确合成数据规则，不扩大忽略范围来掩盖真实泄漏。

<a id="local-tools"></a>
## 本地工具

macOS 的 Vision OCR 实际执行 `/usr/bin/swift vision-ocr.swift`，安装包也依赖本机 Swift 工具链与 macOS SDK。需安装并选用有效的 Xcode 命令行工具或完整 Xcode；检查 `/usr/bin/swift --version`，安装方式见 [Apple 官方说明](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools)。仅检测 `/usr/bin/swift` 路径存在，不能证明工具链已就绪。

Mac 可按 [README 的依赖表](README.md#requirements) 安装 Poppler、SoX 和 whisper.cpp。默认模型为 `~/.cache/whisper.cpp/ggml-base.bin`，`WHISPER_CPP_MODEL` 可覆盖。音视频转换优先使用系统 `afconvert`，`ffmpeg` 为可选后备。

```bash
npm run interview:local:doctor
```

该命令检查软件与模型，不访问麦克风、不证明录音权限。真实收音请在界面明确发起麦克风测试。Windows 的本地录音与 ASR 在代码中禁用，安装这些工具不会解除限制。

| 环境变量 | 用途 |
|---|---|
| `WHISPER_CPP_MODEL` | 本地 whisper GGML 模型绝对路径 |
| `HRBOSS_INTERVIEW_REC_PATH` | SoX `rec` 绝对路径 |
| `HRBOSS_INTERVIEW_SOX_PATH` | `sox` 绝对路径 |
| `HRBOSS_INTERVIEW_AFCONVERT_PATH` | `afconvert` 绝对路径 |
| `HRBOSS_INTERVIEW_FFMPEG_PATH` | 可选 `ffmpeg` 绝对路径 |
| `HRBOSS_INTERVIEW_WHISPER_CLI_PATH` | `whisper-cli` 绝对路径 |

录音工具依次检查显式覆盖、启动 PATH 与标准安装目录。PDF 路径使用 Poppler；扫描 PDF 的 Tesseract 路径需要可执行文件和中文语言包。不要把 PDF OCR 的可用状态解读为非 macOS 截图能力，后者依赖逐图批准的外部多模态 AI。

## 隔离数据与服务

使用独立测试数据目录，按现有合成 fixture 检查组织测试。内部 `HRBOSS_*`、`BOSS_*` 变量名和历史 storage key 为兼容保留，不代表仍有招聘平台联网入口。不要随品牌改名迁移或清空业务数据。

Electron 主进程持有本地服务令牌，renderer 通过受信 IPC 访问服务。开发页面应由 Electron 加载；不要把令牌注入普通浏览器，不要将接口改成对外监听。AI key 通过设置页和系统安全存储管理，不写入仓库。

可选飞书/Lark 妙记导入依赖用户本机已授权的 `lark-cli` 和对应材料权限；当前执行路径依赖 macOS 登录 shell。没有该环境时使用粘贴转写文本的入口，不把它列为启动前提。

## 完整业务备份与恢复

完整操作见[用户指南中的业务恢复](docs/GETTING_STARTED.md#business-restore)。恢复前完全退出、保留受损副本，将同一批次的 data 与外置数据库/面试等材料恢复到记录的原绝对路径，并保留原启动路径设置。匹配版本启动后抽查记录、材料与任务；跨机器/跨路径重映射及旧版二进制回滚未验证。下节仅处理 AI 配置，不代替整套业务恢复。

<a id="ai-credential-recovery"></a>
## 升级与 AI 凭据恢复

本版保留历史 `userData` / 业务数据目录，但这不能保证 Electron `safeStorage` 使用的系统密钥身份继续兼容。macOS Keychain 访问可能受应用名称、身份或设备变化影响；这里只保留数据路径，不承诺旧密文能够解密，也不能自动迁移所有系统密钥。旧 v1 凭据没有加密绑定服务地址，升级后不自动沿用其中的密钥或模型验证，须手动重新输入、测试并启用。

若加密配置无法读取，应用会锁定 AI 设置写入，避免覆盖尚未恢复的配置；反复点击读取或直接输入新密钥不能解除本次启动的锁定。重启后仍出现该错误时，由能管理本机文件的使用者按以下步骤恢复：

1. 记录设置页显示的实际数据目录；完全退出应用，确认相关进程已结束，再备份**整个数据目录**及版本信息。保留数据库、sidecar、材料和任务记录，不能只备份 AI 配置。
2. 将数据目录中的 `external-ai-config.v1.json` 移到访问受限的备份位置，安全隔离原文件，不覆盖或公开它。文件名中的 `v1` 是历史名称，不能据此判断内部存储版本。
3. 同时检查并隔离可能被自动迁移的旧 `rating-config.json`：实际数据目录、应用代码目录（源码运行时为本仓库根目录；打包后为应用资源中的代码目录），以及启动配置 `HRBOSS_RATING_CONFIG_PATH` 指向的位置。设置了该变量时优先使用其指定路径；恢复前确认这些旧凭据不会重新进入启动流程。旧文件可能含明文密钥，不读取到终端、不贴到日志或 Issue。
4. 若启动配置另设了 `HRBOSS_EXTERNAL_AI_*` 覆盖值，先停用这些覆盖，避免重启时继续使用旧连接或凭据。不要为排障打印环境中的密钥。
5. 重启应用，在设置页手动配置可信服务、重新输入密钥、测试模型，确认当前服务与模型后再主动启用。候选人材料外发仍需逐次确认。

这套操作只隔离 AI 配置文件，不删除业务数据或系统钥匙串。若仍无法写入系统安全存储，先修复本机权限或密钥访问问题；保留备份，不把旧密文直接复制到另一台设备并假定可用。

## 构建与发布边界

| 命令 | 行为 |
|---|---|
| `npm run package:local` | 完整验证后运行 Forge，普通输出在 `dist/` |
| `npm run package:mac:arm64` | 干净提交的隔离 macOS 候选构建与自测；候选保留于命令报告的临时目录 |
| `npm run release:mac:internal` | 本地候选归档模式，成功产物放入 `dist/`；历史脚本名保留 |
| `npm run release:source` | 导出源码 ZIP 到 `dist/`，排除运行数据、依赖和旧产物 |

构建不等于上传或发布。macOS 候选需要干净提交并在隔离目录复验；既定首版允许未公证的 Apple Silicon 包，须完成人工业务与安装验收，并由负责人对最终产物明确决定发布。当前候选尚未获发布决定，详见[首发渠道与验收说明](release/FIRST-RELEASE-POLICY.md)。Developer ID 与公证属于后续渠道，使用时须通过 [正式包说明模板](release/MACOS-OFFICIAL-README.md) 中的全部门禁。Windows 构建器仅留给后续技术验收，见 [Windows 候选构建](release/WINDOWS-CANDIDATE-BUILD.md)，当前首发不提供 Windows 包。

公开发布前必须完成干净安装、verify、禁用内容与密钥扫描、许可证及文档链接检查、提交身份核验、纯合成数据人工旅程，以及实际候选包检查。真实外部服务和麦克风验证需另行授权。创建公开仓库、首次推送和发布需负责人明确确认。

## 提交与定位

架构入口见 [源码导览](SOURCE-DEVELOPMENT-TUTORIAL.md)。贡献前阅读 [CONTRIBUTING](CONTRIBUTING.md)。缺陷报告只附合成复现与脱敏日志；漏洞按 [SECURITY](SECURITY.md) 处理。
