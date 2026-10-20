# 安全策略

relic 会改写各 harness 的全局 `AGENTS.md`、注册定时任务、并在安装阶段写入 git 凭据。
这些操作需要被认真对待——本文件说明如何报告问题，以及哪些行为属于设计取舍而非漏洞。

## 支持范围

| 版本 | 状态 |
|---|---|
| `main`（最新提交） | ✅ 接收安全修复 |
| 最新 [Release](https://github.com/STHgs/relic/releases) | ✅ 接收安全修复 |
| 更早的 tag、分叉、个人修改版 | ❌ 不提供修复 |

当前分发状态：唯一的 Release 是 **v0.0.1-beta（预发布）**；`v0.2.0` tag 没有对应的 Release 资产。
判断你实际运行的版本，用 `git -C ~/.config/relic rev-parse --short HEAD` 或 `cat ~/.config/relic-sync/engine.lock`。

## 报告漏洞

**请不要开公开 issue。**

1. 首选：仓库 **Security** 标签页 → *Report a vulnerability*（GitHub 私密安全公告，仅维护者可见）；
2. 备选：给 [@STHgs](https://github.com/STHgs) 发 GitHub 私信。

报告里请包含：

- 受影响的版本 / 提交；
- 操作系统、Node 版本、涉及的 harness（DSH / OpenCode / OMO / Codex）；
- 复现步骤与最小样例；
- 影响面：能读到什么、能写到哪、是否需要用户交互、是否已公开。

## 响应

本项目由单人维护。**尽力在 7 天内确认收到**（这不是 SLA）；修复周期取决于严重性与影响面。
确认后的流程：复现 → 评估 → 修复 → 发布安全公告 → 致谢（除非你要求匿名）。
不提供漏洞赏金。

## 在范围内

- **安装与引导**：`install.sh`、`install.cmd`、`relic-setup.cmd`、`scripts/setup.ps1`、`scripts/sync-silent.vbs`
- **向导本地服务**：`scripts/wizard.mjs`（`127.0.0.1:17777–17779`）
- **凭据**：Gitee / GitHub 令牌的读取、传递与落盘
- **命令执行与路径**：`src/core/exec.mjs`、`src/core/paths.mjs`（命令注入、路径穿越、任意写盘）
- **同步与升级**：`src/core/sync-core.mjs`、`src/core/upgrade-core.mjs`、`src/core/git-ops.mjs`（仓库替换、`engine.lock` 绕过、非预期 push）
- **调度器注册**：`scripts/install-schedule.mjs`（schtasks / launchd / systemd / cron）
- **发布资产**：Release zip 及其中的脚本

## 不在范围内

- **用户自写的规则内容**（内容库里的 `policies.yaml`、`modules/*.yaml`）。
  治理模型是「纯提示词 + 自律执行」，不注入平台权限；规则被模型误读属于该内容或该模型的问题，
  不是引擎漏洞（但欢迎提设计层面的改进 issue）。
- 已经取得本机同用户（或更高）权限之后的横向移动。
- 第三方依赖（`ajv`、`yaml`）自身的漏洞——请同时报给上游；若在 relic 中存在可利用路径，仍请告知。
- 必须让用户主动关掉系统安全机制（解除锁定、`-ExecutionPolicy Bypass`）才成立的「攻击」。

## 已知设计取舍（不是漏洞，但你需要知道）

| 事实 | 说明 |
|---|---|
| 令牌明文写入 `~/.git-credentials` | 沿用 git 凭据存储的通用做法；权限取决于 umask，未额外加密 |
| 令牌经 URL query 传给 Gitee API | Gitee v5 API 的认证方式，可能出现在代理或访问日志中 |
| 向导服务未做 Origin 校验 | 只监听 `127.0.0.1`、不对外，但本机恶意页面理论上可向其发起请求 |
| 治理不注入平台权限 | `deny` 级规则靠模型自律执行，真正的硬边界是平台自带沙箱 |

## 安全使用建议

- 给 relic 用**专用** Gitee 账号或最小权限令牌（仅勾选 `projects`），不要复用主账号的全权限令牌；
- 从 Release 或 `main` 安装，安装前过一眼改动；
- 定时任务以当前用户身份注册，不要用管理员 / root；
- 升级走 `npm run upgrade`，它会跑全量测试与骨架门禁，不要手动 `git pull` 后直接同步。
