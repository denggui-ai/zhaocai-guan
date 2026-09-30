# 招才官 Windows x64 技术候选说明

版本：1.0.1

**Windows 当前仅为实验性源码，首发不提供安装包。** 本文保留给后续技术候选使用，不表示已有可下载便携包或真机验收通过。

## 后续候选目录

完整候选包含 `app/`、`release/`、`CANDIDATE-MANIFEST.json`、`PACKAGE-SHA256SUMS.txt` 和 `START-ZhaocaiGuan.cmd`。启动器调用 `app\ZhaocaiGuan.exe`；不要只复制单个 EXE。

获得明确授权的技术候选后，先按 [Windows 验收清单](windows-release-acceptance-checklist.md) 运行隔离检查，再启动应用。只允许使用合成资料。证据不完整时保持未验证状态。

## 功能边界

本机录音与 ASR 已禁用，安装 SoX 或 whisper.cpp 不会解除限制。岗位、简历文件、人工面试记录等需在真机逐项验证。非 macOS 截图依赖逐图批准的外部多模态 AI；Tesseract 只适用于相应扫描 PDF OCR 路径。

外部 AI 默认关闭，需要用户配置、模型验证和逐次材料确认。没有招聘平台登录、同步或自动联系功能。应用数据应保存在用户本机目录，路径在设置中查看；迁移前退出应用并备份完整数据目录。

自动验收 PASS 不等于 Windows 正式发布完成。未来发布还需真实安装、签名、设备与数据旅程证据。项目源码中的 `release/WINDOWS-CANDIDATE-BUILD.md` 和 `release/WINDOWS-RELEASE-READINESS.md` 说明构建方式及历史发布工具限制；这些开发文档不随便携技术候选复制。
