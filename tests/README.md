# 检查与执行分组

`manifest.json` 是检查入口、支撑文件、运行时、平台、分组与 npm 检查命令的登记来源。新增检查必须登记；遗漏、重复、缺失文件、错误分组以及没有说明的未分组检查都会被拒绝。

```bash
npm run verify
npm run check:extended
node tests/check-suite-runner.js files check-local-directory-selection.js
node tests/check-suite-runner.js ci-core
```

`files` 接受原来的检查文件名或 `tests/` 路径，但只执行已登记的检查，拒绝目录穿越和辅助文件。现有 npm 命令名不变；`support/run-npm-check.js` 从清单读取原有 Node/Electron 执行方式及环境变量，不拼接任意 shell 输入。

- `precheck` / `check`：默认模块与业务回归；`npm run check` 会先运行 npm 的 precheck 生命周期。
- `ui`：由 UI 运行器创建隔离合成数据，再按顺序执行。不能直接跳过 fixture 安全门禁。
- `hr-acceptance`：合成人工招聘旅程；不等于真实材料准确率或干净机器安装验收。
- `extended`：本次发现并接入的 16 个原未登记有效检查，包含备份策略、关闭岗位历史、画像绑定和排序隔离。
- `ci-core` / `ci-macos` / `ci-windows` / `ci-windows-probe`：工作流使用同一清单，保留既有平台范围和失败策略。Windows 普查仍是非阻塞信息采集。

清单中的 `platforms` 是检查的执行目标声明，不表示这些系统已完成本次验收；检查自身的平台守卫和明确 SKIP 保留。`electron-node` 用于匹配 SQLite ABI；原 npm 命令的系统 Node 与 Electron 环境在 commands 中分别保留。

## 明确保留的手动检查

以下三个用例在迁移前提交 `11ba96f` 就已失败，原因是断言旧 UI 源码结构。本次保留原断言并登记原因，不计为本次通过或新增回归：

| 检查 | 原有失败 |
|---|---|
| `check-app-context-commit-001.js` | 旧 `refreshCandidateDetail` 调用形式 |
| `check-candidate-detail-r1.js` | 旧 dirty guard 表达式 |
| `check-workbench-target-id-001.js` | 旧候选人导航表达式 |

`check-candidate-disposition-tabs-runtime.js` 和 `check-job-priority-button-runtime.js` 需要交互式 Electron 桌面并构建前端，保留为明确的按需场景。对应模块改动时应单独执行，不能用离线 CI 代替。

## 新检查的要求

登记 `path`、`kind`、`runtime` 和 `platforms`，加入适用执行组或已有 npm 命令；手动检查必须给出具体 `manualReason`。测试支撑文件登记为 helper，不能作为普通检查启动。验证前后保留用例集合对比，不得通过删除、跳过或放宽断言掩盖回归。

只使用合成资料与隔离临时目录。真实外部 AI、平台账号、麦克风和实际招聘数据不属于默认检查范围。
