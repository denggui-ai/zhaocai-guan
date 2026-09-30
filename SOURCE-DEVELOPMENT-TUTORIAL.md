# 招才官 源码导览

本文介绍 1.0.1 公开版候选的主要边界。启动和验证命令见 [开发指南](DEVELOPMENT.md)。

## 工作区、源码与证据的职责

- 日常开发以本仓库最新 `main` 为基准，在独立分支或 worktree 中修改；不要把旧导出目录当作当前源码。
- 发行源码绑定冻结 Git 提交，与可执行包的构建记录对应；源码 ZIP 是发行快照，不是持续更新的开发目录。
- 审计日志、验收截图与运行记录保存在单独的证据工作区；历史结果保持原样，新增结果注明提交、平台和运行范围。
- 依赖、运行资料及构建产物留在忽略目录，不能进入源码版本或被下一轮构建递归打包。

## 目录职责

| 目录 | 内容 |
|---|---|
| `src/` | Electron 主进程、preload、本机服务与业务模块；保留原模块文件名 |
| `frontend/` | React 界面与前端构建 |
| `tests/` | 检查入口、运行器与统一的 `manifest.json` |
| `tests/support/`、`tests/fixtures/` | 测试支撑模块与合成资料生成器 |
| `native/` | Swift OCR 和 Python 图片拼接工具 |
| `scripts/` | 开发辅助与基准工具 |
| `release/` | 源码归档、平台构建与发行校验 |
| `docs/`、`assets/` | 使用文档、展示材料与应用资源 |

`src/paths.js` 定义应用根目录；资源定位与用户数据目录不依赖终端当前目录。开发目录下原有 `data/` 默认位置保持在根目录，正式应用仍使用原来的用户数据设置。`src/legacy/candidate.html` 保留供兼容检查，不是当前 React 主界面。

检查分组、手动用例与新增登记规则见 [检查说明](tests/README.md)。npm 命令名保持兼容，直接调用旧根目录脚本的命令请按新位置更新。

## 从一次用户操作跟踪代码

| 入口 | 责任 |
|---|---|
| `frontend/src/App.jsx`、`frontend/src/components/` | 岗位、候选人、面试和设置交互；显示加载、失败和待确认状态 |
| `frontend/src/api.js`、`src/preload.js` | renderer 到受信 IPC 的接口边界 |
| `src/candidate-main.js` | Electron 窗口、本地服务生命周期、可信 renderer 校验、密钥与授权 |
| `src/action-server.js`、`src/db-server.js` | 本机操作与查询 API；受令牌和来源检查保护 |
| `src/db.js` | 本地 SQLite 结构、岗位与候选人业务状态、人工操作记录 |
| `src/desktop-branding.js`、`forge.config.js` | 显示品牌、图标和打包身份 |

先从界面调用找到 IPC/API，再追到服务及数据层。状态变化要以服务端结果为准，不因按钮点击便假定保存成功。

## 材料与人工确认

- 截图先进入导入任务与 OCR 草稿，人工对照原图后才能确认入库。macOS 使用系统 Vision；非 macOS 的截图读取需要逐图批准外部多模态 AI。
- 简历导入处理本地文件；测评 PDF 由 `assessment-*` 模块验证、预览并归档。扫描 PDF OCR 与截图导入是不同通道。
- 面试录音、转写和归属由 `local-interview-*`、`interview-*` 模块处理。Windows 本地录音/ASR 明确禁用，不能仅因工具已安装而启用。
- 外部 AI 经 `src/external-ai-policy.js`、`src/secure-llm-config-store.js`、`src/f009-interview-llm.js` 和授权模块约束；结果是待人工核对的草稿，不自动决定录用或淘汰。

## 不得破坏的边界

1. 配置服务必须为 HTTPS OpenAI-compatible；连接变化后不能向新端点静默复用旧凭据或模型验证。
2. 验证模型不等于批准候选人材料外发，材料发送仍逐次确认。
3. 密钥不出现在 renderer 持久存储、数据库、普通日志或源码里；系统加密不可用时明确报告实际状态。
4. 不恢复招聘平台登录、同步、抓取或自动联系代码。
5. 兼容保留的数据目录、schema、环境变量和 storage key 需要独立迁移设计，不能批量替换历史标识。
6. 关闭应用时必须妥善结束本地服务与录音工作进程，不能仅隐藏界面。

## 修改与验证一例

修改材料校对行为时，先读对应组件、调用接口及现有 `check-*`；用合成材料复现原问题。修复后跑涉及的检查，再执行 `npm run verify`。不要为获得绿色结果而删掉不相关检查，也不要把源码字符串匹配当作真机功能验收。

包构建、自测和发布证据工具在 `release/`。构建输出属于 `dist/`，不应进入 Git、源码 ZIP 或下次应用包。macOS 候选构建保留原有隔离临时目录策略，详见 [开发指南](DEVELOPMENT.md)。

## 开源贡献

当前欢迎安装文档、合成材料回归和 Windows 源码验证反馈。请遵循 [贡献指南](CONTRIBUTING.md)，并在报告中区分“代码支持”“自动检查通过”“真机已验收”和“正式发布”。
