// =============================================================================
// src/core/validator.mjs — 唯一权威校验器（ajv 对 schema.json v2）
// =============================================================================
// 治前身毛病 #3：前身 schema.json 是摆设，generate.mjs 第 67-98 行另写了一套
// 手校验逻辑与之平行 → 必然漂移。relic 让 schema.json 成为唯一事实源，ajv 真校验。
//
// 治前身毛病 #1（schema 层）：schema v2 的 patterns.items 是 {pattern, action?} 对象，
// ajv 会直接拒收裸字符串 patterns —— 不靠运行时手检，靠契约本身拦截。
//
// 治前身毛病 #2（schema 层）：schema v2 的 enforcement 枚举只有 runtime/advisory
// （F1 决策：丢弃 hook）。ajv 拒收 enforcement: hook。
//
// 导出:
//   createValidator(schemaPath?) → validate(doc) → { ok, errors, doc }
//     schemaPath: schema.json 路径，默认相对本文件的 ../schema.json
//     useDefaults:true 填默认值；allErrors:true 一次报全
//     errors 为人类可读字符串数组（ajv.errorsText 加上 dataPath）
// =============================================================================

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_PATH = resolve(__dirname, '../../schema.json');

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok
 * @property {string[]} errors  人类可读的错误描述（ok=true 时为空）
 * @property {object} doc      校验后的文档（含 useDefaults 填入的默认值）
 */

/**
 * 构造一个针对 schema.json v2 的校验函数。
 * @param {string} [schemaPath]  schema.json 的绝对路径；默认指向 relic/schema.json
 * @returns {(doc: object) => ValidationResult}
 */
export function createValidator(schemaPath = DEFAULT_SCHEMA_PATH) {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv({
    allErrors: true,
    useDefaults: true,
    strict: false,           // 允许 draft-07 的 if/then/else、const 等，放宽未知关键字告警
    strictSchema: false,
  });
  const validate = ajv.compile(schema);

  return function validateDoc(doc) {
    const ok = validate(doc);
    if (ok) {
      return { ok: true, errors: [], doc };
    }
    const errors = (validate.errors || []).map((e) => {
      const path = e.instancePath || '';
      const field = path || '(root)';
      const msg = e.message || 'invalid';
      const extra = e.params && Object.keys(e.params).length
        ? ' ' + JSON.stringify(e.params)
        : '';
      return `${field}: ${msg}${extra}`;
    });
    return { ok: false, errors, doc };
  };
}

// ─── 方向 3：moduleFragment 独立校验器 ────────────────────────────────
/**
 * 构造一个针对 moduleFragment 定义的校验函数（用于加载模块片段时独立校验）。
 * 复用主 schema.json 的 definitions（permission/workflow/riskLevels）。
 * @param {string} [schemaPath]  schema.json 路径；默认指向 relic/schema.json
 * @returns {(doc: object) => ValidationResult}
 */
export function createModuleValidator(schemaPath = DEFAULT_SCHEMA_PATH) {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv({
    allErrors: true,
    useDefaults: true,
    strict: false,
    strictSchema: false,
  });
  // 构建自包含 moduleFragment schema（带 definitions 让 $ref 可解析）
  const fragmentSchema = {
    ...schema.definitions.moduleFragment,
    definitions: schema.definitions,
  };
  const validate = ajv.compile(fragmentSchema);

  return function validateModule(doc) {
    const ok = validate(doc);
    if (ok) {
      return { ok: true, errors: [], doc };
    }
    const errors = (validate.errors || []).map((e) => {
      const path = e.instancePath || '';
      const field = path || '(root)';
      const msg = e.message || 'invalid';
      const extra = e.params && Object.keys(e.params).length
        ? ' ' + JSON.stringify(e.params)
        : '';
      return `${field}: ${msg}${extra}`;
    });
    return { ok: false, errors, doc };
  };
}

// 默认导出一个用默认 schema 路径构造的实例，方便直接 import 调用。
const defaultValidate = createValidator();
export default defaultValidate;
