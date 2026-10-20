# relic

> 一套身份，多个 AI 平台。把规则、流程、人设编译成各平台都读的 `AGENTS.md`。

relic 是个人 agent 治理系统：你在一个私有内容库里维护规则与人设，relic 负责渲染并投递到
DSH、OpenCode/OMO、Codex 的全局指令文件。改一次，5 分钟内全部生效。
治理是**纯提示词 + 自律执行**（deny 级无例外，中高风险发起前声明），不注入平台权限。

## 名字的由来

relic 取自《赛博朋克 2077》里承载 Johnny Silverhand 人格印记（engram）的生物芯片——
人格与习惯封装进可移植的载体，换机器、换平台依然随身携带。这也是这个项目想做的事：
你调教一次的工作伙伴，不因更换工具而丢失。

## 架构（30 秒）

| 层 | 是什么 | 在哪 |
|---|---|---|
| 引擎 `relic` | 渲染器、骨架门禁、适配器、同步/升级 | 本仓库（GitHub，CI 门禁） |
| 内容 `relic-sync` | 你的规则模块、人设、工作流（私有） | 每身份一库，默认 Gitee |
| 产物 | 各平台 `AGENTS.md` | 本机各 harness 配置目录 |

两条通道，别混：

- **sync（快）**：拉内容 → 骨架校验 → 渲染部署。每 5 分钟由调度器自动跑。
- **upgrade（慢）**：切引擎版本 → `npm ci` → 全量测试 + 门禁 → sync → 写 `engine.lock`。手动、显式。

## 快速开始

前置：Node ≥ 20、Git。

```bash
git clone https://github.com/STHgs/relic.git
cd relic
./install.sh          # Linux / WSL / macOS：装依赖 + 打开浏览器向导
```

Windows 双击 `relic-setup.cmd`（自动装 Node/Git 并启动同一向导），或手动：

```powershell
git clone https://github.com/STHgs/relic.git
cd relic; npm install; npm run wizard
```

向导完成：环境检查 → 选身份（新建 / 接入已有）→ 粘贴 Gitee 令牌（新建时需要，勾选 projects）
→ 部署 → 注册调度器。

不想用 GUI：

```bash
npm run bootstrap     # 同一条链路，纯命令行，适合脚本/CI
```

> 同步库默认 Gitee（大陆可达）；`--provider github` 切 GitHub，需 `gh auth login`。

## 常用命令

| 目的 | 命令 |
|---|---|
| 管理台（状态/恢复/升级/卸载） | `npm run wizard` |
| 立即同步，不等 5 分钟 | `npm run sync` |
| 升级引擎 | `npm run upgrade -- --tag <tag>`（或 `--latest`） |
| 去治理（保留一切，可恢复） | `npm run uninstall -- --level uninject` |
| 恢复治理 | `npm run uninstall -- --reinject` |
| 停服务（含调度器） | `npm run uninstall -- --level deactivate` |
| 完全卸载（删引擎/内容/habits） | `npm run uninstall -- --level full` |
| 骨架门禁 | `npm run check:skeleton` |
| 全量测试 | `npm test` |

## 文件在哪

| 内容 | 路径 |
|---|---|
| 引擎 | `~/.config/relic` |
| 内容库 | `~/.config/relic-sync`（`policies.yaml` + `modules/`） |
| 引擎版本锁 | `~/.config/relic-sync/engine.lock` |
| 本机学习库 | `~/.config/relic-habits/learned.yaml`（不入 git） |
| 部署产物 | `~/.dsh/AGENTS.md`、`~/.config/opencode/AGENTS.md`、`~/.codex/AGENTS.md` 等 |

## 验证

```bash
grep -c "RELIC IS RUNNING" ~/.dsh/AGENTS.md      # ≥1 即注入成功
cat ~/.config/relic-sync/engine.lock             # 引擎版本
systemctl --user list-timers relic-sync.timer    # cron / schtasks 同理
```

新开 agent session，首行出现 `RELIC IS RUNNING @ MMDD-HHMMSS` 即受治理。
`MMDD-HHMMSS` 是实时时间戳——复读旧文本会露馅。

## 日常

- **改规则/人设**：编辑 `~/.config/relic-sync/` 下内容 → commit + push → 5 分钟全域生效。
- **急用**：在引擎 clone 跑 `npm run sync`。
- **加规则/流程**：直接说需求，触发 `add-permission` / `add-workflow` 对话流程。
- **固化偏好**：说“记住……”，agent 会申请写入 `personas.directives`（全域生效）。

## 故障排查

| 症状 | 处置 |
|---|---|
| `内容库不存在` | clone 内容库到 `~/.config/relic-sync`，或 `npm run init-sync` |
| 骨架门禁 FAIL A | 改过渲染器但没 bump golden：同提交跑 `npm run check:skeleton -- --bump-golden` |
| sync 报 dirty / diverged | 先在内容库 commit/push；relic 绝不自动 stash 或强推 |
| push 被拒 | `gh auth refresh -h github.com -s repo,workflow` |
| 端口 17777 被占 | 关掉旧向导；17777–17779 自动顺延 |
| 自定义安装路径找不到 | 内容库 `harness-paths.json` 声明 > `DSH_HOME`/`OPENCODE_CONFIG`/`XDG_CONFIG_HOME` > 默认路径 |
| Windows 调度器注册失败 | 管理员 PowerShell 重跑，或手动 `schtasks /Create /TN relic-sync /SC MINUTE /MO 5 /TR "cmd /c cd /d <repo> && npm run sync"` |

## 开发

- 提交门：`npm test` 全绿 + `npm run check:skeleton` PASS。
- **改渲染器必须在同一提交 bump golden**；新增渲染输入要登记进 `computeDeterminismState`（输入闭合不变量）。
- 架构与扩展点见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，协作约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构、数据流、不变量
- [docs/SYNC.md](docs/SYNC.md) — 同步语义、调度器接入、升级失败边界
- [CONTRIBUTING.md](CONTRIBUTING.md) — 开发环境、测试、PR 约定
- 许可证：[MIT](LICENSE)
