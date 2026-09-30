<picture>
  <source media="(max-width: 640px)" srcset="docs/brand/readme-hero-mobile.svg">
  <img src="docs/brand/readme-hero.svg" alt="招才官——AI 帮你起草，招聘由你掌握。把招聘需求，整理成可编辑的 JD。" width="1280">
</picture>

<h1 align="center">带 AI 起草的本地招聘工作台</h1>
<p align="center">用自然语言描述需求，AI 整理成可编辑 JD。<br>简历、候选人和面试进度，继续在本机管理。</p>

<p align="center">
  <a href="https://github.com/denggui-ai/zhaocai-guan/releases/download/v1.0.1-rc.1/ZhaocaiGuan-macOS-arm64-1.0.1-20260930-r5-internal.dmg"><img src="docs/brand/download-mac.svg" alt="下载 Mac Apple 芯片版 DMG" width="244" height="52"></a>
</p>
<p align="center"><strong>Mac Apple 芯片 · 1.0.1 候选版（rc.1）· 未获 Apple 公证</strong><br>
<a href="docs/GETTING_STARTED.md#install">安装帮助</a> · <a href="https://github.com/denggui-ai/zhaocai-guan/releases/tag/v1.0.1-rc.1">发行说明与其他下载</a> · <a href="README.en.md">English</a></p>

## 说清招聘需求，让 AI 起个草稿

**不用从空白 JD 开始。** 写下实际工作、必须条件和加分项，AI 帮你整理结构，并把还需确认的信息列出来。

> “必须会用 Excel 做数据透视，能解释报表数字从哪里来、怎样核对。有活动复盘经验是加分项，不是硬性要求。”

| 你给出的需求 | 这次 AI 实际整理的结果 |
|---|---|
| 商品资料、活动排期、周报与沟通 | 4 条岗位职责 |
| 数据透视、数据来源与核对 | 2 条必须条件 |
| 复盘经验是加分项 | 单列加分项 |
| 地点、薪资、作息、到岗时间未定 | 留作确认问题，没有编造到正文里 |

**确认发送 → AI 起草 → 人工修改 → 保存草稿。** 保存后还需另行启用；招聘决定由你做。

[**看完整输入、AI 原稿和人工修改结果 →**](docs/AI-DEMO.md)

*已用虚构材料在实际 r5 应用中完成 DeepSeek `deepseek-flash` 的这一条 JD 流程。检查提示仍有两处误报，详见演示记录。其他 AI 场景和服务尚未验收；外部 AI 默认关闭，需自备服务配置，可能收费。*

## 打开工作台，跟进有条理

谁还需要核对资料，谁已经排好面试，下一步该做什么——放在同一个岗位下查看。

[![招才官 r5 实际工作台：两位虚构候选人、三项待办和一次人工面试安排](docs/showcase/workbench.png)](docs/showcase/workbench.png)

*真实 Mac 应用截图，岗位和人物均为虚构。点击图片可查看大图。[查看候选人和面试界面 →](docs/DEMO.md)*

### 从收到简历，到跟进面试

**资料归到岗位里。** 导入你有权使用的简历，核对后确认建档，原始材料保留供回看。

**候选人进度看得清。** 已知事实、待补资料、跟进记录集中查看；下一步由 HR 决定。

**面试安排有记录。** 手工记录时间、面试官与候选人反馈，保留每一轮的处理历史。

## 用两份虚构简历，走完第一次体验

**不需要 AI Key，也不用连接招聘平台账号。** 从 TXT 简历开始，就能体验本地整理与手工跟进。

[**下载体验材料 ZIP →**](https://github.com/denggui-ai/zhaocai-guan/releases/download/v1.0.1-rc.1/ZhaocaiGuan-demo-materials-1.0.1.zip)　[跟着图文步骤操作](docs/GETTING_STARTED.md#first-use)

1. **建一个岗位** — 复制样例 JD，启用并确认岗位画像。
2. **导入两份简历** — 核对姓名、岗位与原文，再确认建档。
3. **打开候选人** — 回看原始材料，需要时手工记录面试安排。

完成后，岗位下应有 **2 位候选人**，重开应用后资料仍保留。[材料清单与校验](docs/examples/README.md)

## 开始之前，你可能想了解

<details>
<summary><strong>适用电脑、安装与可选工具</strong></summary>

| 电脑 | 当前状态 |
|---|---|
| Mac Apple 芯片（M 系列 / arm64） | [下载 DMG](https://github.com/denggui-ai/zhaocai-guan/releases/download/v1.0.1-rc.1/ZhaocaiGuan-macOS-arm64-1.0.1-20260930-r5-internal.dmg)；1.0.1 候选版，未获 Apple 公证 |
| Mac Intel 芯片 | 仅源码，未验收，无已验证安装包 |
| Windows x64 | 实验性源码，暂无安装包；本地录音与转写禁用 |
| Linux | 未支持 |

在苹果菜单“关于本机”查看芯片。下载后核对 SHA-256，把 `招才官.app` 放入“应用程序”，按[安装与首次打开指引](docs/GETTING_STARTED.md#install)操作。当前包采用 ad-hoc 本地签名；不要关闭全局系统安全保护。干净 Mac 安装等仍未完成验收；AI 目前仅完成上述 JD 单场景实测，完整范围见[发行说明](https://github.com/denggui-ai/zhaocai-guan/releases/tag/v1.0.1-rc.1)。

<a id="requirements"></a>
**需要时再开启进阶能力。** Mac 截图识别需 Xcode 命令行工具或完整 Xcode；PDF 需 Poppler；录音/本地转写需 SoX、whisper-cli 和模型。这些依赖不随应用打包，详见[按需准备工具](docs/GETTING_STARTED.md#optional-tools)。截图识别后先校对再建档，转写和 AI 草稿也需人工核对。


</details>

<a id="external-ai"></a>
<details>
<summary><strong>AI、资料存储与备份</strong></summary>

- **不用 AI 也能开始。** 外部 AI 默认关闭，TXT 简历整理和手工跟进无需 AI Key。需要辅助起草或分析时，再配置自己的 HTTPS OpenAI-compatible 服务并验证模型；已完成 DeepSeek `deepseek-flash` 的[一次 JD 起草实测](docs/AI-DEMO.md)，不代表其他功能或服务已通过验收。
- **发送材料前逐次确认。** 核对用途、拟发送材料和服务后再批准；保存密钥不等于批准外发。服务方可能收费并按其规则处理材料。[AI 配置步骤](docs/GETTING_STARTED.md#optional-ai)
- **招聘资料主要存于本机。** 批准外部 AI、授权飞书/Lark 导入时会联网。升级前退出应用并备份整套资料，而非只复制数据库主文件。[备份与恢复](docs/GETTING_STARTED.md#business-restore)


</details>

<details>
<summary><strong>适合谁？与招聘平台是什么关系？</strong></summary>

适合希望在自己的 Mac 上整理招聘工作的 HR 和招聘负责人。当前以单机使用为主，不提供团队共享招聘后端。

招才官与 BOSS 直聘等平台无官方关联，不连接平台账号、自动同步、抓取或自动联系候选人。招聘沟通和邀约由你完成。

</details>

<details>
<summary><strong>遇到问题，怎样获得帮助？</strong></summary>

安装被拦截、Windows 支持、是否需要 AI Key、截图/PDF 缺工具等问题，见[安装与使用 FAQ](docs/GETTING_STARTED.md#help)。

[报告使用问题](https://github.com/denggui-ai/zhaocai-guan/issues/new?template=bug_report.yml) · [提出建议](https://github.com/denggui-ai/zhaocai-guan/issues/new?template=feature_request.yml) · [后续计划](ROADMAP.md)

反馈时说明版本、Mac 芯片、操作步骤、预期与实际结果。仅附虚构或脱敏材料，勿上传真实简历、电话或密钥。安全漏洞按[安全策略](SECURITY.md)私下报告。提交 Issue 需要登录 GitHub，下载安装包不需要。

</details>

<details>
<summary><strong>开发、构建与源码</strong></summary>

准备 Node.js 22 或更高版本、npm；Mac 还需 Xcode 命令行工具。在源码根目录执行：

```bash
npm ci
npx --no-install electron-rebuild -f -w better-sqlite3
npm run ui
```

Electron 固定为 42.5.1；SQLite 模块须匹配 Electron ABI。完整环境、检查与构建见[开发指南](DEVELOPMENT.md)，结构说明见[源码导览](SOURCE-DEVELOPMENT-TUTORIAL.md)。


</details>

---

采用 [GNU AGPL-3.0](LICENSE)（`AGPL-3.0-only`）。第三方组件保留各自许可证，见[第三方声明](THIRD_PARTY_NOTICES.md)和[许可证文本](THIRD_PARTY_LICENSES.txt)。版本变化见[CHANGELOG](CHANGELOG.md)，产品边界见[开源决策](docs/decisions/2026-09-28-open-source.md)，新名称见[品牌决定](docs/decisions/2026-09-30-zhaocai-guan.md)。
