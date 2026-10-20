# 架构

relic 把"一个身份"的规则、流程、人设编译成各 AI 平台都能读的 `AGENTS.md`，并负责投递、同步与升级。
治理方式是**纯提示词 + 自律执行**：不注入运行时权限，真正的硬边界是平台自带沙箱。

## 边界：引擎与内容

| 仓库 | 职责 | 生命周期 |
|---|---|---|
| `relic`（本仓库） | 渲染器、适配器、门禁、同步/升级管线 | 静态权威源，按 tag 发布 |
| `<your-id>/relic-sync`（每身份一个） | 规则模块、人设、工作流、`engine.lock` | 用户私有，随时改 |

本仓库只放引擎；身份内容由 `template/` 播种到用户自己的内容库。CI 断言本仓库不出现 `policies.yaml` / `modules/`。

## 目录

```
src/core/        loader · module-loader（profile 合并）· validator（ajv）· conflict（三层冲突）
                 inject（规则写入 CLI）· skeleton（骨架门禁逻辑）· sync-core · upgrade-core
                 habits（本机学习库）· paths（四层解析链）· exec（平台无关执行层）· provider（Gitee/GitHub）
src/render/      agents-md.mjs —— 纯函数渲染器
src/adapters/    opencode · omo · dsh · codex（route A：只产 AGENTS.md）
src/orchestrator/generate.mjs —— 载入→校验→渲染→探测→安装 流水线
scripts/         bootstrap · sync · wizard · upgrade · install-schedule · tier4-skeleton · init-sync …
template/        新身份种子（manifest + 4 个通用模块 + 人设样板）
tests/           node:test 单测与分层集成（Tier1–Tier4）
docs/            SYNC.md（同步/调度器/升级边界）· ARCHITECTURE.md（本文件）
```

## 流水线

```
内容库 policies.yaml + modules/*.yaml
        │  loadProfile：manifest 载入 + profile 选模块 + 跨模块冲突检测
        ▼
   validate（schema v2，ajv）
        │  mergeFragments → 带溯源的单份策略
        ▼
   render/agents-md.mjs（纯函数） → AGENTS.md 文本
        │  适配器 detect（四层路径解析）
        ▼
   install（幂等写盘 + 备份 + 内容未变跳过）
        │
        ▼
   各平台：~/.dsh/AGENTS.md、~/.config/opencode/AGENTS.md、~/.codex/AGENTS.md …
```

## 渲染器纯度与确定性

- **渲染器是纯函数**：`src/render/` 不读文件、不取时钟、不读环境变量。机器相关输入只有两个，经 `policies.meta` 注入：
  - `runtimeRoot`：本机 clone 根，用于 workflow 索引绝对路径；
  - `habits`：本机学习库视图（`buildHabitsView`）。
- 稳定通道 = **golden 骨架**（`tests/fixtures/golden-skeleton.md`），只含可移植内容；易变通道 = **inputSig**（内容 commit + golden + 渲染器源码摘要 + 本机视图），输入变即合法重录。
- 易变区在产物内用 `<!-- BEGIN/END RELIC-VOLATILE:<region> store=<摘要> date=<日期> -->` 自证来源。
- 任何新增渲染输入，必须登记进 `computeDeterminismState`，否则门禁会以"同输入不同输出"停机。

## 适配器

全部走 route A：只生成 `AGENTS.md`，不碰平台 JSON 配置里的权限。

- `detect`：内容库 `harness-paths.json` 声明 > 官方环境变量（`DSH_HOME` / `OPENCODE_CONFIG` / `XDG_CONFIG_HOME` / `CODEX_HOME`）> 约定路径。
- `install`：`isContentUnchanged` 命中则跳过；否则写盘前备份，`.bak.*` 由 `cleanup-backups` 去重清理。

## 同步（快通道）

`src/core/sync-core.mjs` 的 `runSync`：

1. **门控**：定时器上下文下探测是否有 harness 消费者在跑，无则静默跳过；手动执行放行。
2. **安全**：内容库工作树脏 → 拒绝；远端分叉或非 fast-forward → 拒绝；绝不 stash、绝不强推。
3. **拉取**：`--ff-only` 拉取内容库更新。
4. **门禁**：`skeleton` 断言在 `generate` 之前执行，失败即停（防止把漂移的治理写进各平台）。
5. **渲染与投递**：渲染 + 各适配器安装。
6. **哨兵校验**：产物必须包含 `RELIC IS RUNNING` 哨兵，否则报错。
7. **状态**：写 `last-sync`（时间、内容 commit、inputSig、产物摘要）。

调度器由 `install-schedule.mjs` 注册：systemd（cron 回退）/ launchd / schtasks，默认 5 分钟。

## 升级（慢通道）

`src/core/upgrade-core.mjs` 的 `upgradeSteps` 是显式状态机：

```
preflight（工作树干净、身份可用、内容库在 main）
  → fetch
  → checkout 目标 tag（detached）
  → npm ci
  → 全量测试 + 骨架门禁
  → sync --content --no-gate
  → 写 engine.lock（commit → push，逐项校验）
```

失败边界：

- **sync 之前失败**：恢复原 checkout 与依赖，锁定关系不变；
- **sync 之后失败**：保留目标版本现场并如实报错（治理已写入，不能假装没发生）；
- 锁写入不成功不报成功。

首次升级用 `upgradeSteps({ repo, target, content, env })` 显式指定仓库；日常在部署 clone 内 `npm run upgrade -- --tag <tag>`。

## 学习库（机器级记忆）

- agent 在"因用户偏好调整了输出方式"的轮次写 `~/.config/relic-habits/learned.yaml`（不入 git）。
- 重计算下放到 sync：衰减排序 `score = hits × 0.7^周数`，容量 30 条，头部 3 条常驻注入，`hits≥3 且前 2 且存活≥7 天` 生成固化申请。
- 固化由用户确认后写入内容库 `personas.directives`，再删除对应 habit 条目。

## 测试分层

| 层 | 内容 |
|---|---|
| 单元 | loader / validator / conflict / module-loader / habits / provider |
| Tier1 | 渲染产物与历史基线等价 |
| Tier2 | 哨兵与平台配置不被触碰 |
| Tier3 | 同步语义（脏拒、分叉拒、哨兵检） |
| Tier4 | 骨架门禁（断言 A 等价 + B 确定性守卫） |

## 不变量清单

1. 渲染器纯函数，不读盘、不取时钟。
2. 同输入同输出；新增输入必须登记。
3. golden 与渲染器变更同提交。
4. 引擎库不含身份内容。
5. 安装幂等，内容未变不写盘。
6. 同步不 stash、不强推、脏拒。
7. 门禁在写入之前。
8. 升级失败要么完整恢复，要么保留现场并如实报告。
