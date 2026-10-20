// Controlled engine upgrades. No destructive reset and no promise of deployment rollback.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { run as runExec, userHome } from './exec.mjs';

export function discoverUpgradeContent({ repo, content, env = process.env, home = userHome() }) {
  if (content || env.RELIC_CONTENT_REPO) return resolve(content || env.RELIC_CONTENT_REPO);
  const path = join(repo, 'relic.config.json');
  if (existsSync(path)) {
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    if (cfg.contentRepo) return resolve(cfg.contentRepo);
  }
  return join(home, '.config', 'relic-sync');
}

/**
 * Both CLI and wizard consume these progress events. Inject run only in tests.
 * Before sync: restore checkout + dependencies on failure. After sync starts:
 * keep target checkout, because adapters may already have written files.
 * Never reset content history or discard user changes.
 */
export async function* upgradeSteps({ repo, target = 'latest', content,
  env = process.env, home = userHome(), run = runExec, now = () => new Date().toISOString() }) {
  const childEnv = { ...env, HOME: home, GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_TERMINAL_PROMPT: '0' };
  const exec = (cmd, args, cwd = repo) => run(cmd, args, { cwd, env: childEnv, maxBuffer: 32 * 1024 * 1024 });
  const requireOk = (r, label) => {
    if (!r.ok) throw new Error(`${label}: ${r.stderr || r.stdout || `exit=${r.status}`}`);
    return r.stdout.trim();
  };
  const git = (args, cwd = repo) => requireOk(exec('git', args, cwd), `git ${args.join(' ')}`);
  const clean = (cwd, label) => {
    if (git(['status', '--porcelain'], cwd)) throw new Error(`${label}工作树不干净；请先 commit 或 stash（不自动处理）`);
  };
  let stage = 'preflight', original = null, branch = null, switched = false;
  let dependenciesStarted = false, deploymentStarted = false, deployed = false;
  let commit = null, contentDir = null, lockCommitted = false;
  try {
    yield { step: 1, status: 'active', message: '检查引擎和内容库，获取目标版本...' };
    if (!target || target.startsWith('-')) throw new Error('目标版本不能为空或以 - 开头');
    clean(repo, '引擎');
    original = git(['rev-parse', '--verify', 'HEAD']);
    const b = exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (b.ok) branch = b.stdout.trim();
    else if (b.status !== 1) throw new Error(`读取引擎分支失败: ${b.stderr}`);
    contentDir = discoverUpgradeContent({ repo, content, env, home });
    if (resolve(contentDir) === resolve(repo)) throw new Error('内容库不能是引擎库');
    if (!existsSync(join(contentDir, 'policies.yaml'))) throw new Error(`内容库不存在: ${contentDir}`);
    clean(contentDir, '内容库');
    if (git(['rev-parse', '--show-prefix'], contentDir)) throw new Error('内容路径必须是 git 仓库根目录');
    if (git(['symbolic-ref', '--quiet', '--short', 'HEAD'], contentDir) !== 'main') {
      throw new Error('内容库必须位于 main（sync 使用 origin/main）');
    }
    git(['remote', 'get-url', 'origin'], contentDir);
    git(['var', 'GIT_AUTHOR_IDENT'], contentDir);
    git(['var', 'GIT_COMMITTER_IDENT'], contentDir);
    git(['fetch', 'origin', 'main'], contentDir);
    git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], contentDir);
    git(['fetch', 'origin', '--tags']);
    if (target === 'latest') {
      target = git(['tag', '--sort=-creatordate']).split('\n').filter(Boolean)[0] || 'origin/main';
    }
    commit = git(['rev-parse', '--verify', '--end-of-options', `${target}^{commit}`]);
    yield { step: 1, status: 'done', message: `目标：${target} (${commit.slice(0, 8)})` };

    stage = 'checkout';
    yield { step: 2, status: 'active', message: `切换到 ${commit.slice(0, 8)}...` };
    git(['checkout', '--detach', commit]);
    switched = true;
    yield { step: 2, status: 'done', message: '目标 checkout 就绪' };

    stage = 'dependencies';
    yield { step: 3, status: 'active', message: '按 package-lock 安装依赖...' };
    dependenciesStarted = true;
    requireOk(exec('npm', ['ci']), 'npm ci 失败');
    yield { step: 3, status: 'done', message: '依赖就绪' };

    stage = 'test';
    yield { step: 4, status: 'active', message: '运行全量测试与骨架门禁...' };
    const tests = exec('npm', ['test']);
    const output = (tests.stdout + '\n' + tests.stderr).replace(/\x1b\[[0-9;]*m/g, '');
    const fails = output.match(/^# fail (\d+)/m)?.[1];
    if (!tests.ok || (fails !== undefined && fails !== '0')) {
      throw new Error(`测试未全绿（fail=${fails ?? '?'}）\n${output.slice(-6000)}`);
    }
    stage = 'skeleton';
    requireOk(exec('npm', ['run', 'check:skeleton']), '骨架门禁失败');
    clean(repo, '测试后的引擎');
    yield { step: 4, status: 'done', message: '测试及骨架门禁全绿' };

    if (git(['rev-parse', 'HEAD']) !== commit) throw new Error('测试期间引擎 HEAD 已改变，拒绝部署');
    stage = 'sync';
    yield { step: 5, status: 'active', message: '重新部署；此后失败不声称全量回滚' };
    deploymentStarted = true;
    requireOk(exec('npm', ['run', 'sync', '--', '--no-gate', '--content', contentDir]), 'sync 失败（可能已部分写入）');
    deployed = true;
    yield { step: 5, status: 'done', message: 'sync 完成' };

    stage = 'lock';
    if (git(['rev-parse', 'HEAD']) !== commit) throw new Error('部署期间引擎 HEAD 已改变，拒绝写入错误版本锁');
    yield { step: 6, status: 'active', message: '更新并发布 engine.lock...' };
    clean(contentDir, '部署后的内容库');
    const lockPath = join(contentDir, 'engine.lock');
    let lock = null;
    if (existsSync(lockPath)) {
      try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { /* replace invalid lock after successful deployment */ }
    }
    if (lock?.engine !== 'relic-source' || lock?.commit !== commit || lock?.tag !== target) {
      writeFileSync(lockPath, JSON.stringify({ engine: 'relic-source', tag: target, commit, pinned: now() }, null, 2) + '\n');
      git(['add', '--', 'engine.lock'], contentDir);
      git(['commit', '-m', `chore: engine upgraded to ${target} (${commit.slice(0, 8)})`, '--', 'engine.lock'], contentDir);
      lockCommitted = true;
    }
    // Explicit destination: never publish to a differently configured upstream.
    stage = 'push';
    git(['push', 'origin', 'HEAD:refs/heads/main'], contentDir);
    yield { step: 6, status: 'done', message: `升级完成：${target}；engine.lock 已确认推送` };
    return { version: target, commit, contentDir };
  } catch (error) {
    let recovery = '引擎未切换；未启动部署';
    if (switched && !deploymentStarted) {
      try {
        clean(repo, '恢复前的引擎');
        if (git(['rev-parse', 'HEAD']) !== commit) throw new Error('引擎 HEAD 已被其他进程移动，拒绝覆盖');
        if (branch) {
          const branchSha = git(['rev-parse', '--verify', `refs/heads/${branch}`]);
          if (branchSha !== original) throw new Error('原分支已被其他进程移动，拒绝自动恢复');
          git(['checkout', branch]);
        } else git(['checkout', '--detach', original]);
        if (git(['rev-parse', 'HEAD']) !== original) throw new Error('恢复后 HEAD 不匹配');
        recovery = `已恢复原引擎 ${original.slice(0, 8)}；未启动部署`;
        if (dependenciesStarted) {
          requireOk(exec('npm', ['ci']), '原版本依赖恢复失败');
          recovery += '；原版本依赖已恢复';
        }
      } catch (restoreError) {
        recovery = `自动恢复未完成：${restoreError.message}；请检查 HEAD 和依赖，未启动部署`;
      }
    } else if (deploymentStarted) {
      recovery = `${deployed ? 'sync 已完成' : 'sync 可能已部分写入'}；保留目标引擎 ${commit.slice(0, 8)}，未自动回滚部署文件或内容库`;
      if (stage === 'push') recovery += `；engine.lock ${lockCommitted ? '已本地提交' : '保持现有记录'}但远端发布未确认，请在内容库重试 git push origin HEAD:refs/heads/main`;
      else if (deployed) recovery += '；engine.lock 尚未确认提交/发布，请检查内容库后重试升级';
    }
    throw new Error(`[${stage}] ${error.message}\n${recovery}`, { cause: error });
  }
}
