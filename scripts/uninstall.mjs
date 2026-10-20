// =============================================================================
// scripts/uninstall.mjs — relic 卸载 CLI 入口
// =============================================================================
// 用法：
//   npm run uninstall                                    → 交互式选择级别
//   npm run uninstall -- --level uninject                 → 去治理（移除 AGENTS.md）
//   npm run uninstall -- --level deactivate               → 停服务（+停调度器）
//   npm run uninstall -- --level full                      → 完全卸载
//   npm run uninstall -- --reinject                        → 恢复去治理
// =============================================================================

import { createInterface } from 'readline';
import { listDeployed, uninject, reinject, deactivate, fullUninstall } from '../src/core/uninstall-core.mjs';

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

const ask = (q) => new Promise((res) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a.trim()); });
});

async function main() {
  // 恢复模式
  if (process.argv.includes('--reinject')) {
    console.log('[uninstall] 恢复去治理（从备份还原 AGENTS.md）...');
    const r = await reinject();
    console.log(r.ok ? '✓ 恢复完成' : '✗ ' + r.errors.join('; '));
    process.exit(r.ok ? 0 : 1);
  }

  // 检测当前部署状态
  const deployed = listDeployed();
  if (deployed.length === 0) {
    console.log('[uninstall] 未检测到已部署平台——无需卸载');
    process.exit(0);
  }

  console.log('\n当前部署：');
  for (const p of deployed) {
    console.log(`  ✓ ${p.name}  ${p.filePath}`);
  }

  // 确定级别
  let level = argOf('--level');
  if (!level) {
    console.log('\n卸载级别：');
    console.log('  1. 去治理（移除 AGENTS.md，保留一切——可用 --reinject 恢复）');
    console.log('  2. 停服务（上述 + 停用调度器）');
    console.log('  3. 完全卸载（上述 + 删引擎/内容库/habits ⚠️ 身份数据将丢失）');
    level = await ask('\n选择 [1/2/3]: ');
    level = { '1': 'uninject', '2': 'deactivate', '3': 'full' }[level] || 'uninject';
  }

  // full 前强制确认
  if (level === 'full') {
    console.log('\n⚠️  完全卸载将删除：');
    console.log('  - 所有 AGENTS.md（治理文本）');
    console.log('  - 调度器（timer/schtasks）');
    console.log('  - 内容库（你的全部规则、人设、工作流）');
    console.log('  - 学习习惯（habits）');
    console.log('  - 引擎目录');
    console.log('\n内容库会先 push 到远程（如果已配置）。');
    const confirm = await ask('确认完全卸载？输入 YES 继续: ');
    if (confirm !== 'YES') {
      console.log('已取消');
      process.exit(0);
    }
  }

  // 执行
  console.log(`\n[uninstall] 执行 ${level}...\n`);
  let result;
  if (level === 'uninject') result = await uninject();
  else if (level === 'deactivate') result = await deactivate();
  else result = await fullUninstall();

  // 报告
  console.log('\n结果：');
  if (result.removed) {
    for (const f of result.removed) console.log(`  ✓ 已移除 ${f}`);
  }
  if (result.saved) {
    console.log(`  📦 备份保存到 ${result.saved[0]?.split('/').slice(0, -1).join('/')}`);
  }
  if (result.scheduler) {
    for (const s of result.scheduler) console.log(`  ✓ 调度器 ${s.platform}: ${s.detail}`);
  }
  if (result.removedDirs) {
    for (const d of result.removedDirs) console.log(`  ✓ ${d.label}: ${d.path}`);
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) console.log(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`\n🎉 ${level} 完成。`);
  if (level === 'uninject') {
    console.log('如需恢复: npm run uninstall -- --reinject');
  }
  process.exit(0);
}

main();
