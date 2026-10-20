// Controlled upgrade CLI; wizard uses the same core and failure boundaries.
// npm run upgrade -- [--tag <tag|commit>|--latest] [--content <repo>]
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { upgradeSteps } from '../src/core/upgrade-core.mjs';

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
  for await (const event of upgradeSteps({ repo, ...options })) {
    console.log(`[upgrade] ${event.status === 'done' ? '✓' : '…'} ${event.message}`);
  }
} catch (error) {
  console.error(`[upgrade] FAILED ${error.message}`);
  process.exitCode = 1;
}
