// =============================================================================
// src/orchestrator/generate.mjs — 流水线控制器
// =============================================================================
// 取代前身的巨型 generate.mjs。职责单一：
//   1. 检测哪些平台适配器在场（detect）
//   2. 跑在场适配器的 generate 产出 FileMap
//   3. install（或 dryRun 仅报告）
//
// 关键设计：
//   - 适配器列表显式注入（不在模块里硬编码 import 全部），便于测试 mock 与将来加 Codex/Cursor
//   - 默认导出跑标准 3 适配器（opencode/omo/claude），用 import() 动态加载
//   - 检测到的适配器才跑 generate；未检测到的进 skipped
//   - dryRun=true：只产 FileMap + 报告，不写盘
// =============================================================================

import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { readFileSync } from 'fs';
import { parse } from 'yaml';
import opencodeAdapter from '../adapters/opencode.mjs';
import omoAdapter from '../adapters/omo.mjs';
import dshAdapter from '../adapters/dsh.mjs';
import codexAdapter from '../adapters/codex.mjs';
import { loadPolicies } from '../core/loader.mjs';
import { createValidator } from '../core/validator.mjs';
import { loadProfile } from '../core/module-loader.mjs';
import { loadHabitsView } from '../core/habits.mjs';

const DEFAULT_ADAPTERS = [opencodeAdapter, omoAdapter, dshAdapter, codexAdapter];  // claude 已退役；codex 2026-09-23 入列

/**
 * @typedef {Object} GenerateOptions
 * @property {string} [home]             HOME 目录，默认 process.env.HOME
 * @property {boolean} [dryRun]           true=仅报告不写盘
 * @property {object[]} [adapters]       适配器数组，默认 3 个内置适配器
 * @property {(p: string) => boolean} [existsSync]  fs.existsSync 注入（测试 mock）
 */

/**
 * 跑 detect→generate→install 流水线。
 * @param {object} policies  已校验的 policies 对象
 * @param {GenerateOptions} [opts]
 * @returns {Promise<{ok:boolean, fileMaps:object, report:object, dryRun:boolean}>}
 *   fileMaps: { adapterId: FileMap }；report: 各适配器 InstallReport 汇总
 */
export async function generate(policies, opts = {}) {
  const {
    home = process.env.HOME,
    dryRun = false,
    adapters = DEFAULT_ADAPTERS,
    existsSync: exists = existsSync,
  } = opts;

  const env = { home, existsSync: exists, ...(opts.env !== undefined ? { env: opts.env } : {}) };  // env 透传：测试干净 env 隔离（CI XDG/DSH_HOME 泄漏根治）
  const fileMaps = {};
  const reports = {};
  const allWritten = [];
  const allBackups = [];
  const allSkipped = [];
  const allErrors = [];
  let ok = true;

  for (const adapter of adapters) {
    const id = adapter.id;
    const detected = adapter.detect(env);

    if (!detected) {
      allSkipped.push(`${id} (not detected)`);
      reports[id] = { ok: true, written: [], backups: [], skipped: [`${id} (not detected)`], errors: [] };
      continue;
    }

    // generate（纯函数，无 I/O）
    const fm = adapter.generate(policies, env);
    fileMaps[id] = fm;

    if (dryRun) {
      allSkipped.push(`${id} (dryRun)`);
      reports[id] = { ok: true, written: [], backups: [], skipped: [`${id} (dryRun)`], errors: [] };
      continue;
    }

    // install
    const r = adapter.install(fm, { home, dryRun: false, ...(opts.env !== undefined ? { env: opts.env } : {}) });  // env 透传至 install（与 detect 同型）
    reports[id] = r;
    if (r.ok) {
      allWritten.push(...r.written);
      allBackups.push(...r.backups);
    } else {
      ok = false;
      allErrors.push(...r.errors);
    }
    allSkipped.push(...(r.skipped || []));
  }

  return {
    ok,
    fileMaps,
    report: {
      ok,
      written: allWritten,
      backups: allBackups,
      skipped: allSkipped,
      errors: allErrors,
    },
    dryRun,
  };
}

// =============================================================================
// CLI 入口：node src/orchestrator/generate.mjs [--policies <path>] [--profile <id>] [--dry-run]
// =============================================================================
// 默认行为：读 ./policies.yaml（或 --policies 指定路径）→ 校验 → 检测平台 →
// 真写（不 dryRun，用户跑 generate 就是想生效）。--dry-run 只预览不写盘。
// --profile <id>：如果 manifest 有 profiles 段，用 loadProfile 加载 profile 对应的模块子集。
//   无 --profile 但 manifest 有 default:true profile → 自动用 default profile。
//   无 profiles 段 → 走单文件 loadPolicies（现有行为，现有测试不破坏）。
// 输出 JSON 报告到 stdout；错误到 stderr；退出码 0=成功 / 1=参数或校验错。
// =============================================================================

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const policiesIdx = args.findIndex((a) => a.startsWith('--policies'));
  const policiesPath = policiesIdx >= 0
    ? resolve(args[policiesIdx + 1] || '')
    : resolve(process.cwd(), 'policies.yaml');
  const profileIdx = args.findIndex((a) => a.startsWith('--profile'));
  const profileName = profileIdx >= 0 ? (args[profileIdx + 1] || '') : undefined;

  if (!existsSync(policiesPath)) {
    console.error(JSON.stringify({ ok: false, error: `policies.yaml not found: ${policiesPath}` }));
    process.exit(1);
  }

  try {
    // 分支：如果 manifest 有 profiles 段 或 用户传了 --profile，走 loadProfile
    const manifestRaw = parse(readFileSync(policiesPath, 'utf8'));
    const hasProfiles = Array.isArray(manifestRaw.profiles) && manifestRaw.profiles.length > 0;

    let policies;
    if (hasProfiles || profileName) {
      const r = loadProfile({ manifestPath: policiesPath, profileName });
      if (!r.ok) {
        console.error(JSON.stringify({ ok: false, stage: 'load', errors: r.errors }, null, 2));
        process.exit(1);
      }
      policies = r.policies;
    } else {
      // 单文件模式（现有行为）
      policies = loadPolicies(policiesPath);
      const validate = createValidator();
      const v = validate(policies);
      if (!v.ok) {
        console.error(JSON.stringify({ ok: false, stage: 'validate', errors: v.errors }, null, 2));
        process.exit(1);
      }
      policies = v.doc;
    }

    // roadmap 索引绝对路径不变量：内容根 = manifest 所在目录（引擎 cwd 无关，天然支持内容库分离）
    if (policies.meta) policies.meta.runtimeRoot = dirname(policiesPath);
    // 本机习惯视图（纯度不变量）：读取在管线侧完成，渲染器只吃显式输入。
    // 刻意不放在 generate() 内部——否则测试与第三方调用会被运行机器的库污染。
    if (policies.meta) policies.meta.habits = loadHabitsView();

    const r = await generate(policies, { dryRun });
    console.log(JSON.stringify({
      ok: r.ok,
      dryRun: r.dryRun,
      written: r.report.written,
      backups: r.report.backups,
      skipped: r.report.skipped,
      errors: r.report.errors,
      fileMaps: r.dryRun ? r.fileMaps : undefined,
    }, null, 2));
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}
