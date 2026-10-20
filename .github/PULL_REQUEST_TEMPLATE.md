## 动机

<!-- 解决什么问题；关联 issue：Fixes #... -->

## 改动面

- [ ] 渲染器 `src/render/`
- [ ] 适配器 `src/adapters/`
- [ ] 核心管线 `src/core/`
- [ ] 安装 / 调度 `scripts/`
- [ ] 文档 / 模板 / 测试

## 验证

- [ ] `npm test` 全绿（0 fail）
- [ ] `npm run check:skeleton` PASS
- [ ] 改了渲染器 → 已在**同一提交**运行 `npm run check:skeleton -- --bump-golden`
- [ ] 新增了渲染输入 → 已登记进 `computeDeterminismState`
- [ ] 未提交身份内容：`policies.yaml`、`modules/`、`AGENTS.md`、`output/`、`relic.config.json`

## 平台验证矩阵

<!-- 只勾选真正跑过的；未跑请写「未验证」，不要留空让人猜 -->

| 平台 | 版本 | 结果 |
|---|---|---|
| Windows 10/11 | Node | |
| WSL | Node | |
| Linux | Node | |
| macOS | Node | |

## 风险与回滚

<!-- 影响哪些用户路径？出问题怎么退回去？ -->
