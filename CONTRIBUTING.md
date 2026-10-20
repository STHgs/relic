# 贡献指南

感谢你对 relic 感兴趣。这是个人向的可移植 agent 治理系统，先读架构再改代码。参与讨论与提交即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 环境

- Node.js ≥ 20，Git
- 依赖仅 `ajv` 与 `yaml`，`npm ci` 即可

```bash
git clone https://github.com/STHgs/relic.git
cd relic
npm ci
npm test
```

## 提交门禁

任何 PR 必须同时满足：

1. `npm test` 全绿（0 fail）；
2. `npm run check:skeleton` PASS（骨架门禁）。

CI 在 `main` push 与 PR 上跑同一条链，见 `.github/workflows/ci.yml`。

## 不变量（改代码前必读）

| 不变量 | 含义 |
|---|---|
| 渲染器是纯函数 | `src/render/` 不读文件、不取时钟、不读环境变量；机器输入经 `policies.meta` 显式注入 |
| 同输入同输出 | 输入摘要见 `computeDeterminismState`，新增渲染输入必须同步登记 |
| golden 同提交 | 改渲染器必须在**同一提交**运行 `npm run check:skeleton -- --bump-golden`，golden 的 diff 即审查材料 |
| 引擎库不含内容 | 本仓库不得出现 `policies.yaml`、`modules/`、`personas` 等身份内容（CI 断言拦截），它们属于每个用户自己的内容库 |
| 写入幂等 | `install` 重复执行不产生重复内容；内容未变时跳过写盘 |

## 代码约定

- ESM（`.mjs`）+ JSDoc，不引入 TypeScript。
- 路径比较用 `posix.join`，真实文件操作用原生 `join`/`dirname`（Windows 兼容，见 `src/core/paths.mjs` 注释）。
- 外部命令统一走 `src/core/exec.mjs`（数组参数，win32 才走 shell）。
- 平台差异集中在 `src/core/paths.mjs` 与适配器里，不散落在业务代码。

## 提交与 PR

- 一个 PR 只做一件事，说明动机、改动面、验证方式。
- 提交信息：`type: 摘要`（feat / fix / docs / test / refactor / chore）。
- 不提交机器专有信息：绝对路径、个人令牌、`relic.config.json`、`AGENTS.md`、`output/`（均已在 `.gitignore`）。
- 新增适配器或模块时，同步补测试与文档，并在 PR 里说明验证矩阵。
- `main` 已启用分支保护：禁止强推与删除，管理员同样受限；维护者仍可直接推送。「要求状态检查」未启用——实测它会连直推一起拦（`Required status check "gate" is expected`），与「维护者直推」的工作流冲突；PR 合并前请自行确认 `gate` 通过。

## 新增适配器

1. 复制 `src/adapters/dsh.mjs` 作为模板（route A：只产 `AGENTS.md`）。
2. 实现 `detect` / `generate` / `install`，路径解析走四层链（声明 > 环境变量 > 约定）。
3. 在 `src/orchestrator/generate.mjs` 的 `DEFAULT_ADAPTERS` 注册。
4. 在 `tests/adapters.test.mjs` 增加探测、FileMap、幂等安装三类断言。

## 安全

- 治理是**纯提示词 + 自律执行**，不注入平台权限；不要试图在这里加运行时 hook。
- 发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。
