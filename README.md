# 招才官 · Zhaocai Guan

**从岗位要求到面试复盘，让招聘判断有据可查。**

为 HR 整理岗位、简历、面试和测评材料。资料本地管理，AI 按需连接外部服务。

[**下载 Mac 版**](https://github.com/denggui-ai/zhaocai-guan/releases/download/v1.0.1-rc.1/ZhaocaiGuan-macOS-arm64-1.0.1-20260930-r5-internal.dmg) · [快速开始](docs/GETTING_STARTED.md#first-use) · [安装帮助](docs/GETTING_STARTED.md#install) · [English](README.en.md)

Mac Apple 芯片 · **1.0.1-rc.1 预发布版** · 未获 Apple 公证 · [发行说明与其他下载](https://github.com/denggui-ai/zhaocai-guan/releases/tag/v1.0.1-rc.1)

[![招才官实际工作台：按岗位查看待办、候选人与面试进度，图中人物与岗位均为虚构](docs/showcase/workbench.png)](docs/DEMO.md)

*实际 r5 Mac 应用截图，使用虚构资料。[查看候选人资料与面试界面 →](docs/DEMO.md)*

## 一段招聘需求，怎样变成可核对的 JD

这条案例来自实际应用中的一次 DeepSeek `deepseek-flash` 调用，使用完全虚构的岗位需求。

1. **输入需求。** 招电商运营专员，会用 Excel 做数据透视；活动复盘经验为加分项，薪资、地点等暂未确定。
2. **AI 整理。** 生成 4 条职责、2 条必须条件及独立加分项，并列出待确认的信息。
3. **人工确认。** 补充“每周提交一页运营小结”的交付要求，保存为第 1 版草稿，尚未启用。

[![真实 JD 草稿：人工补充交付要求后保存，启用版本仍是单独的人工操作](docs/ai-demo/saved-draft.png)](docs/AI-DEMO.md)

[实际输入](docs/ai-demo/input.txt) · [AI 原稿](docs/ai-demo/ai-output.txt) · [人工修改](docs/ai-demo/manual-final.txt) · [完整过程与两处提示误报](docs/AI-DEMO.md)

**这是 JD 单场景实测，其他 AI 场景仍待验收。** 外部 AI 默认关闭，需自备配置，可能收费；每次发送材料前确认。

## 在招聘的每一步，找到材料依据

| 你要完成的工作 | 可以得到什么 |
|---|---|
| **明确用人要求** | 从负责人访谈提炼岗位画像，区分原话与推断，列出证据标准和待追问问题 |
| **起草职位描述** | 整理职责、必须条件与加分项，生成可编辑的 JD 草稿 |
| **核对候选人简历** | 对照岗位查看匹配、不匹配和未知项，附原文依据、能力维度雷达与面试追问 |
| **复盘面试** | 从转写与笔记整理关键事实、岗位核对、矛盾与待确认事项，保留材料引用 |
| **交叉核验测评** | 联合岗位、简历、已确认测评及面试，整理优势、风险、矛盾和补充核验问题 |

五项均有界面入口与外部模型调用实现，真实服务实测目前仅覆盖上述 JD 流程。[完整能力、入口与验证状态 →](docs/AI-CAPABILITIES.md)

AI 整理材料、提供第二意见，HR 核对事实并作招聘决定。初评的能力维度分、测评分析的独立匹配分与建议，均不自动改变 S/A/B/C 或默认排序。

## 用两份虚构简历开始

**不需要 AI Key，也不用连接招聘平台账号。** 先体验本地资料整理与手工跟进。

[下载体验材料 ZIP](https://github.com/denggui-ai/zhaocai-guan/releases/download/v1.0.1-rc.1/ZhaocaiGuan-demo-materials-1.0.1.zip) · [跟着图文步骤操作](docs/GETTING_STARTED.md#first-use)

1. 建一个岗位：复制样例 JD，启用并确认岗位画像。
2. 导入两份简历：核对姓名、岗位与原文，再确认建档。
3. 打开候选人：回看原始材料，需要时手工记录面试安排。

完成后，正确岗位下应有 **2 位候选人**，原始材料可打开，重开应用后仍保留。[材料清单与校验](docs/examples/README.md)

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
