// Controlled upgrade CLI; wizard uses the same core and failure boundaries.
// npm run upgrade -- [--tag <tag|commit>|--latest] [--content <repo>]
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { upgradeSteps } from '../src/core/upgrade-core.mjs';
import { ensureLayout } from '../src/core/migrate-layout.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
try {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--latest') options.target = 'latest';
    else if (arg === '--tag' || arg === '--content') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数`);
      options[arg === '--tag' ? 'target' : 'content'] = value;
    } else throw new Error(`未知参数：${arg}`);
  }

  // 参数合法后才触发布局迁移（硬切 v0.0.4）：非法调用不产生副作用
  const mig = ensureLayout();
  if (!mig.ok) throw new Error(`目录迁移失败：${mig.reason || '未知错误'}`);

  for await (const event of upgradeSteps({ repo, ...options })) {
    console.log(`[upgrade] ${event.status === 'done' ? '✓' : '…'} ${event.message}`);
  }
} catch (error) {
  console.error(`[upgrade] FAILED ${error.message}`);
  process.exitCode = 1;
}
