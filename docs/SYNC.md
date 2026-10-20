# relic 同步机制（sync）

## 语义

`npm run sync` 在任意 clone 内执行：

```
git status --porcelain   # 脏 → 拒绝（绝不静默 stash）
git fetch origin main
git merge --ff-only      # 分叉 → 拒绝（绝不 force）
npm run generate         # 各平台适配器本地渲染 + install（自带 backup）
哨兵自检                  # 每个写出的 AGENTS.md 必含 RELIC IS RUNNING
写 .last-sync            # { time, commit, pulled }
```

退出码 0=成功，1=失败（stdout/stderr 人类可读）。

## 角色

| 角色 | 标记 | 行为 |
|---|---|---|
| dev clone（开发位） | 无 `.relic-deploy` | 可提交可推送；跑测试 |
| deploy clone（部署位） | `.relic-deploy` + pre-commit 护栏 | 只 pull，本地提交被 hook 拒绝 |

把当前 clone 初始化为部署位：`npm run sync -- --init-deploy`

## 宿主调度器接入（平台无关原语 + 各平台定时器）

### Linux / WSL（systemd user timer）

`~/.config/systemd/user/relic-sync.service`:
```
[Unit]
Description=relic sync

[Service]
Type=oneshot
WorkingDirectory=<clone 路径>
ExecStart=/usr/bin/env npm run sync
```

`~/.config/systemd/user/relic-sync.timer`:
```
[Unit]
Description=relic sync every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

启用：`systemctl --user enable --now relic-sync.timer`

### Linux / WSL（cron，无 systemd 时）

```
*/5 * * * * cd <clone 路径> && npm run sync >> ~/.relic-sync.log 2>&1
```

### Windows 原生（Task Scheduler）

```
schtasks /Create /TN "relic-sync" /SC MINUTE /MO 5 /TR "cmd /c cd /d <clone> && npm run sync"
```

### macOS（launchd）

`install-schedule.mjs` 在 darwin 下自动写并加载 `~/Library/LaunchAgents/dev.relic.sync.plist`（StartInterval=300，日志 `~/.relic-sync.log`）——无需手工。

### Windows 原生（2026-09-15 适配）

- 命令执行：`src/core/exec.mjs` 数组化（win32 经 shell 解析 npm.cmd；POSIX 行为不变），sync/tier4/install-schedule 已迁移
- 调度器：`install-schedule.mjs` win32 分支 = `schtasks /Create /TN relic-sync /SC MINUTE /MO 5`
- 路径：`src/core/paths.mjs` 平台变体；opencode Windows 双路径探测（AppData\Roaming\opencode 优先，.config 兜底，真机实测后收敛）
- HOME 归一：USERPROFILE > HOME > os.homedir（exec.userHome）
- 待真机验证项：Windows node 环境跑 `npm run bootstrap` 全链 + opencode 实际指令读取路径确认

## 一致性说明

- 生成产物不入库（Q5）：每次 sync 在本地 generate，产物 = 派生物
- 测试权威性（v5 计划原则 3）：验收以 `npm test`（L1）+ Tier1/2（L2）+ Tier3 sync.test（L3）为准；单平台行为（如 DSH 热注入）仅为冒烟参考

## 通用同步门控（2026-09-22，全平台统一）

`npm run sync` 的**第 0 步**（在脏拒之前）：仅**定时器上下文**（无 TTY）判定
"任一 harness 进程在场才执行"——dsh/opencode/omo 全不在场 = 无消费者 = 静默跳过
（exit 0 + gate 日志一条）。**手动调用永远全量**（isTTY 直通）；`--no-gate` 可强制绕过。

- 核心模块：`src/core/gate.mjs`（进程签名表 + 平台探测 posix=pgrep / win=wmic + 日志）
- 日志：posix `~/.local/state/relic/sync-gate.log` / win `%LOCALAPPDATA%\relic\sync-gate.log`
- 调度器只管定时；win vbs 只管静默（门控已在 sync 内部，fdaf102 的 vbs 门控段已卸载）
- 探测失败保守放行（宁可空转不误跳同步）

## 托管平台（2026-09-29：同步库默认 Gitee）

- **同步库（relic-sync）默认 Gitee**：init-sync 走 Gitee API v5 建库（`--provider github` 切回 gh CLI 流）
- 认证差异：Gitee = 私人令牌（设置→安全设置→私人令牌，勾选 projects，粘贴一次入 credential store）；GitHub = gh 设备码
- 存量部署不受影响：sync 只认 origin，已迁移的 clone 零改动
- 引擎库（relic）留 GitHub——CI 门禁依赖 GitHub Actions
- 已有身份多平台接入不变：clone URL 填 Gitee 地址即可

## harness 位置四层解析链（2026-09-23，自定义安装支持）

`src/core/paths.mjs` 按以下优先序解析各 harness 的部署位置（调研 DSH/OpenCode/Claude Code/chezmoi/XDG 后对齐业界共识）：

| 层 | 机制 | 覆盖场景 |
|---|---|---|
| 1 显式声明 | 内容库 `harness-paths.json`（示例 `harness-paths.example.json`） | 用户自定义安装——亲口声明，绝对可靠，跨机同步 |
| 2 标准环境变量 | `DSH_HOME` / `OPENCODE_CONFIG` / `OMO_HOME` / `CODEX_HOME` / `XDG_CONFIG_HOME`（仅绝对路径合法，spec 规范） | 设了官方 env 的用户 |
| 3 harness settings 反推 | （待实施，候选队列） | 用户在 harness 配置里改路径但未设系统 env |
| 4 约定路径兜底 | `~/.dsh` `~/.config/opencode`（XDG 默认） `~/.omo` `~/.codex` 等 | 默认安装用户零感知 |

修法注记：opencode 走 XDG 解析（`~/.config` 仅为默认值）；omo 实测为点目录 `~/.omo`（非 XDG）——两 harness 行为不同，均已按真机事实固定。

## 骨架门禁（Tier4，2026-09-14；输入闭合修订 2026-10-09）

`npm run sync` 在 generate 之前运行骨架门禁；GitHub CI 在 push 后独立复核：

- **断言 A（等价）**：`render(探针策略) === tests/fixtures/golden-skeleton.md`（字节级）。
  拦截"改了渲染器但没 bump golden"的非法系统变更。探针必须**撑满全部条件段**
  （风险分级/替代方案/人设/索引表/habits 偏好表/⭐ 固化段/易变区标记），否则该结构永不进 golden
  （habits-v2 正是漏了 habits 槽位 → 该条件段此前无守护）。
- **断言 B（确定性守卫 v2）**：渲染必须是**全部输入**的纯函数。
  `inputSig = hash(内容commit + golden全文 + 渲染器源码 + 本机 habits 视图)`；
  输入一致而产物不一致 → 拒绝部署（非确定性/篡改）；输入变化（含本机库写入、跨天衰减重排）→ 合法重录。
  既拦"用户区提交侵蚀骨架 / 同输入不同输出"，又**不误报**本机数据变化。

**纯度不变量（2026-10-09 事故修复）**：渲染器（`src/render/agents-md.mjs`）不读文件、不取时钟、不读 env；
机器输入一律经 `policies.meta` 显式注入，读取发生在管线侧（`generate` CLI / `pipeline()`）；
低级 `generate()` 保持纯透传（防测试与第三方调用被运行机器的库污染）。
产物内机器本地区域用 `<!-- BEGIN/END RELIC-VOLATILE:<region> store=<8位摘要> date=<YYYY-MM-DD> -->`
标记 + 溯源；`SOURCE_DATE_EPOCH` 可作渲染日期（可复现重放）。

**系统变更的合法仪式**：改 `src/render/agents-md.mjs` 的同一提交里运行
`npm run check:skeleton -- --bump-golden` 并提交更新后的 golden——golden 的 diff 就是审查材料。
**注册新渲染输入**：渲染器一旦新增对外部数据的依赖，必须同时纳入 `computeDeterminismState`
的输入签名（漏登记 = 库一改就误报停机）。

**边界**：门禁只守护骨架（结构/哨兵/固定话术/索引格式）；workflow steps、risk items、
permission patterns 属用户主权区，零审查。

## 拆分后架构（2026-09-15，v7）

- 引擎：`STHgs/relic`（静态权威源；本机 `~/.config/relic`；升级 `npm run upgrade -- --tag <t>`）
- 内容：`<your-id>/relic-sync`（本身份；本机 `~/.config/relic-sync`；改规则在此 commit+push）
- 发现链：`--content` 参数 > `RELIC_CONTENT_REPO` env > 引擎 `relic.config.json` > `~/.config/relic-sync`
- 新机器接入：`git clone relic → npm run bootstrap`（自动 init-sync 或 clone 已有身份库）

### 受控升级与失败恢复（2026-10-20）

CLI 与向导共用同一升级管线：引擎/内容脏拒 → fetch → 固定目标 commit →
`npm ci` → 全量测试 → 骨架门禁 → `sync --no-gate --content <同一内容库>` → engine.lock 提交/推送。
CLI 支持 `npm run upgrade -- --tag <tag或commit> --content <内容库>`；不传目标则按 tag 创建时间选择，
无 tag 时使用 origin/main（不表示语义版本最高）。内容发现链同上。
内容库须处于 main，且不能有未发布的本地提交；升级不会自动提交用户改动。

| 失败位置 | 行为与处置 |
|---|---|
| 切版本之前 | 非零退出，不部署、不更新版本锁 |
| 依赖、测试、门禁 | 工作树干净且 HEAD/原分支未被并发移动时恢复原 checkout，再恢复旧依赖；恢复失败单独报告 |
| sync 开始之后 | 可能已有部分平台文件写入；不自动回滚文件、内容历史或依赖，保留目标 checkout 并明确报告 |
| engine.lock add/commit | 部署已完成，锁可能尚未提交；保留现场，检查内容库状态，不报告升级成功 |
| engine.lock push | 本地锁提交保留、远端发布未确认；在内容库执行 `git push origin HEAD:refs/heads/main` 后再重试 |

重复成功升级同一目标不刷新 pinned 或制造重复提交。
不要并发编辑、运行另一升级或同步任务；当前管线不提供跨进程事务锁。
旧安装仍执行本地旧控制器，远端合并修复不会自动赋予旧脚本恢复能力；首次升级需明确使用已审查的新控制器。

### 后续开发方向（Windows 原生适配暂缓，用户拍板 2026-09-15）

- sync-core 跨平台执行（去 `sh -c`，Windows 用 cmd/args 数组）
- Windows 调度器（schtasks）与路径处理
- 内容库轻量 CI（引擎兼容检查）
