/**
 * Safe Zero-eval Mathematical & Attribute Calculation Engine.
 *
 * Capabilities:
 *   1. Recursive-descent formula parser & evaluator (zero eval / zero Function).
 *   2. Multi-sided dice roller (`roll(count, sides, modifier)` & `rollNotation`) + probability checks.
 *   3. Value clamping (`clamp`) & weighted random sampling (`weightedPick`).
 *   4. Multi-layer stat stacking calculator (baseAdd -> percentAdd -> percentMult -> flatFinal).
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function clamp(value, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Number.isFinite(min) ? min : 0;
  const lo = Number.isFinite(min) ? min : -Infinity;
  const hi = Number.isFinite(max) ? max : Infinity;
  if (lo > hi) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Roll `count` dice with `sides` faces and add `modifier`.
 * @param {number} [count=1]
 * @param {number} [sides=6]
 * @param {number} [modifier=0]
 * @param {() => number} [rng=Math.random]
 */
export function roll(count = 1, sides = 6, modifier = 0, rng = Math.random) {
  const c = clamp(Math.floor(Number(count) || 1), 1, 200);
  const s = clamp(Math.floor(Number(sides) || 6), 2, 10000);
  const m = Number.isFinite(Number(modifier)) ? Number(modifier) : 0;
  const rolls = [];
  let subtotal = 0;
  for (let i = 0; i < c; i++) {
    const face = Math.floor(clamp(rng(), 0, 0.999999999) * s) + 1;
    rolls.push(face);
    subtotal += face;
  }
  const total = subtotal + m;
  const modStr = m === 0 ? '' : m > 0 ? `+${m}` : `${m}`;
  return {
    expression: `${c}d${s}${modStr}`,
    count: c,
    sides: s,
    modifier: m,
    rolls,
    subtotal,
    total,
  };
}

/**
 * Parse and roll standard dice notation such as "2d6+3" or "1d100".
 * @param {string} notation
 * @param {() => number} [rng=Math.random]
 */
export function rollNotation(notation, rng = Math.random) {
  const match = String(notation || '')
    .trim()
    .match(/^(\d*)[dD](\d+)\s*([+-]\s*\d+)?$/);
  if (!match) {
    throw new Error(`无效的骰子表达式: "${notation}"`);
  }
  const count = match[1] ? Number(match[1]) : 1;
  const sides = Number(match[2]);
  const modifier = match[3] ? Number(match[3].replace(/\s+/g, '')) : 0;
  return roll(count, sides, modifier, rng);
}

/**
 * Perform a probability check.
 * @param {number} probability - Value in [0, 1] (or [0, 100] when scale === 100)
 * @param {{ scale?: 1 | 100, rng?: () => number }} [options]
 */
export function chanceCheck(probability, { scale = 1, rng = Math.random } = {}) {
  const normalized = scale === 100 ? clamp(probability, 0, 100) / 100 : clamp(probability, 0, 1);
  const sample = clamp(rng(), 0, 0.999999999);
  return {
    passed: sample < normalized,
    roll: Number((sample * scale).toFixed(4)),
    threshold: Number((normalized * scale).toFixed(4)),
    scale,
  };
}

/**
 * Pick one entry from a list according to non-negative weights.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => number} [weightFn]
 * @param {() => number} [rng=Math.random]
 * @returns {T | null}
 */
export function weightedPick(items, weightFn = (x) => Number(x?.weight ?? 1), rng = Math.random) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const weights = items.map((item) => Math.max(0, Number(weightFn(item)) || 0));
  const total = weights.reduce((acc, w) => acc + w, 0);
  if (total <= 0) {
    return items[Math.floor(clamp(rng(), 0, 0.999999999) * items.length)];
  }
  let cursor = clamp(rng(), 0, 0.999999999) * total;
  for (let i = 0; i < items.length; i++) {
    cursor -= weights[i];
    if (cursor < 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Multi-layer stat stacking calculator:
 *   final = ((base + sum(baseAdd)) * (1 + sum(percentAdd)) * prod(1 + percentMult)) + sum(flatFinal)
 *
 * Supported modifier layers:
 *   - 'baseAdd'     (alias: 'flatBase')    : flat bonus added before percent scaling
 *   - 'percentAdd'  (alias: 'addPct')      : additive percentage (e.g. 0.25 => +25%)
 *   - 'percentMult' (alias: 'multPct')     : multiplicative percentage (e.g. 0.1 => *1.10)
 *   - 'flatFinal'   (alias: 'finalAdd')    : flat bonus added after all multipliers
 *   - 'override'                           : replaces final value directly
 *
 * @param {number} baseValue
 * @param {Array<{ id?: string, layer: string, value: number, source?: string, enabled?: boolean }>} [modifiers=[]]
 * @param {{ min?: number, max?: number, round?: 'none'|'round'|'floor'|'ceil' }} [options]
 */
export function computeStackedStat(baseValue, modifiers = [], options = {}) {
  const base = Number.isFinite(Number(baseValue)) ? Number(baseValue) : 0;
  let baseAdd = 0;
  let percentAddTotal = 0;
  let percentMultFactor = 1;
  let flatFinal = 0;
  let overrideValue = null;
  const appliedModifiers = [];

  for (const mod of modifiers || []) {
    if (!mod || mod.enabled === false) continue;
    const val = Number(mod.value);
    if (!Number.isFinite(val)) continue;
    const layer = String(mod.layer || 'baseAdd');

    if (layer === 'baseAdd' || layer === 'flatBase') {
      baseAdd += val;
    } else if (layer === 'percentAdd' || layer === 'addPct') {
      percentAddTotal += val;
    } else if (layer === 'percentMult' || layer === 'multPct') {
      percentMultFactor *= 1 + val;
    } else if (layer === 'flatFinal' || layer === 'finalAdd') {
      flatFinal += val;
    } else if (layer === 'override') {
      overrideValue = val;
    } else {
      continue;
    }
    appliedModifiers.push({
      id: mod.id || null,
      layer,
      value: val,
      source: mod.source || null,
    });
  }

  let computed =
    overrideValue !== null
      ? overrideValue
      : (base + baseAdd) * (1 + percentAddTotal) * percentMultFactor + flatFinal;

  if (options.round === 'floor') computed = Math.floor(computed);
  else if (options.round === 'ceil') computed = Math.ceil(computed);
  else if (options.round === 'round') computed = Math.round(computed);
  else computed = Number(computed.toFixed(6));

  if (options.min !== undefined || options.max !== undefined) {
    computed = clamp(computed, options.min ?? -Infinity, options.max ?? Infinity);
  }

  return {
    base,
    final: computed,
    breakdown: {
      baseAdd,
      percentAddTotal: Number(percentAddTotal.toFixed(6)),
      percentMultFactor: Number(percentMultFactor.toFixed(6)),
      flatFinal,
      overrideValue,
      appliedModifiers,
    },
  };
}

// ============================================================
// Safe Zero-eval Tokenizer & Recursive-Descent Formula Parser
// ============================================================

const BUILTIN_FUNCTIONS = Object.freeze({
  min: (...args) => Math.min(...args),
  max: (...args) => Math.max(...args),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  round: (x, digits = 0) => {
    const d = Math.max(0, Math.min(8, Math.floor(Number(digits) || 0)));
    const factor = 10 ** d;
    return Math.round(x * factor) / factor;
  },
  abs: (x) => Math.abs(x),
  sqrt: (x) => Math.sqrt(Math.max(0, x)),
  pow: (a, b) => Math.pow(a, b),
  clamp: (v, lo, hi) => clamp(v, lo, hi),
  log: (x) => Math.log(Math.max(1e-12, x)),
  exp: (x) => Math.exp(x),
  sign: (x) => Math.sign(x),
  lerp: (a, b, t) => a + (b - a) * clamp(t, 0, 1),
  roll: (count = 1, sides = 6, mod = 0) => roll(count, sides, mod).total,
});

function resolveDotPath(scope, path) {
  const parts = path.split('.');
  let current = scope;
  for (const part of parts) {
    if (FORBIDDEN_KEYS.has(part)) {
      throw new Error(`禁止访问受保护属性: "${part}"`);
    }
    if (current === null || current === undefined || typeof current !== 'object') {
      return 0;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) {
      return 0;
    }
    current = current[part];
  }
  if (typeof current === 'boolean') return current ? 1 : 0;
  const num = Number(current);
  return Number.isFinite(num) ? num : 0;
}

function tokenizeFormula(expression) {
  const src = String(expression || '');
  const tokens = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Two-character operators
    const two = src.slice(i, i + 2);
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(two)) {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }

    // Single-character operators and punctuation
    if ('+-*/%^()?:,<>!'.includes(ch)) {
      const type = ch === '(' || ch === ')' || ch === ',' ? 'punct' : 'op';
      tokens.push({ type, value: ch });
      i++;
      continue;
    }

    // Number literal
    if (/[0-9.]/.test(ch)) {
      let start = i;
      let dotCount = 0;
      while (i < src.length && /[0-9.]/.test(src[i])) {
        if (src[i] === '.') dotCount++;
        i++;
      }
      if (dotCount > 1) {
        throw new SyntaxError(`无效的数字字面量: "${src.slice(start, i)}"`);
      }
      const raw = src.slice(start, i);
      const val = Number(raw);
      if (!Number.isFinite(val)) {
        throw new SyntaxError(`无法解析数字: "${raw}"`);
      }
      tokens.push({ type: 'num', value: val });
      continue;
    }

    // Identifier (supports dot paths like actor.atk or stats.hp)
    if (/[a-zA-Z_$]/.test(ch)) {
      let start = i;
      while (i < src.length && /[a-zA-Z0-9_$.]/.test(src[i])) {
        i++;
      }
      const ident = src.slice(start, i);
      if (ident.endsWith('.') || ident.includes('..')) {
        throw new SyntaxError(`无效的标识符路径: "${ident}"`);
      }
      if (ident === 'true') {
        tokens.push({ type: 'num', value: 1 });
      } else if (ident === 'false') {
        tokens.push({ type: 'num', value: 0 });
      } else {
        tokens.push({ type: 'ident', value: ident });
      }
      continue;
    }

    throw new SyntaxError(`公式包含非法字符 "${ch}"（位置 ${i}）`);
  }

  tokens.push({ type: 'eof', value: null });
  return tokens;
}

function parseAndEvalTokens(tokens, variables, customFunctions = {}) {
  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseTernary() {
    let cond = parseLogicalOr();
    if (peek().type === 'op' && peek().value === '?') {
      consume();
      const whenTrue = parseTernary();
      if (peek().type !== 'op' || peek().value !== ':') {
        throw new SyntaxError('三元运算符缺少 ":"');
      }
      consume();
      const whenFalse = parseTernary();
      return cond ? whenTrue : whenFalse;
    }
    return cond;
  }

  function parseLogicalOr() {
    let left = parseLogicalAnd();
    while (peek().type === 'op' && peek().value === '||') {
      consume();
      const right = parseLogicalAnd();
      left = left || right ? 1 : 0;
    }
    return left;
  }

  function parseLogicalAnd() {
    let left = parseComparison();
    while (peek().type === 'op' && peek().value === '&&') {
      consume();
      const right = parseComparison();
      left = left && right ? 1 : 0;
    }
    return left;
  }

  function parseComparison() {
    let left = parseAdditive();
    while (peek().type === 'op' && ['>', '>=', '<', '<=', '==', '!='].includes(peek().value)) {
      const op = consume().value;
      const right = parseAdditive();
      if (op === '>') left = left > right ? 1 : 0;
      else if (op === '>=') left = left >= right ? 1 : 0;
      else if (op === '<') left = left < right ? 1 : 0;
      else if (op === '<=') left = left <= right ? 1 : 0;
      else if (op === '==') left = Math.abs(left - right) < 1e-9 ? 1 : 0;
      else if (op === '!=') left = Math.abs(left - right) >= 1e-9 ? 1 : 0;
    }
    return left;
  }

  function parseAdditive() {
    let left = parseMultiplicative();
    while (peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseMultiplicative();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseMultiplicative() {
    let left = parsePower();
    while (peek().type === 'op' && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = consume().value;
      const right = parsePower();
      if (op === '*') left = left * right;
      else if (op === '/') left = right === 0 ? 0 : left / right;
      else if (op === '%') left = right === 0 ? 0 : left % right;
    }
    return left;
  }

  function parsePower() {
    let base = parseUnary();
    if (peek().type === 'op' && peek().value === '^') {
      consume();
      const exp = parsePower();
      return Math.pow(base, exp);
    }
    return base;
  }

  function parseUnary() {
    if (peek().type === 'op' && (peek().value === '+' || peek().value === '-' || peek().value === '!')) {
      const op = consume().value;
      const operand = parseUnary();
      if (op === '+') return +operand;
      if (op === '-') return -operand;
      return operand ? 0 : 1;
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (tok.type === 'num') {
      consume();
      return tok.value;
    }

    if (tok.type === 'ident') {
      const name = consume().value;
      // Function call
      if (peek().type === 'punct' && peek().value === '(') {
        consume(); // '('
        const args = [];
        if (!(peek().type === 'punct' && peek().value === ')')) {
          args.push(parseTernary());
          while (peek().type === 'punct' && peek().value === ',') {
            consume();
            args.push(parseTernary());
          }
        }
        if (peek().type !== 'punct' || peek().value !== ')') {
          throw new SyntaxError(`函数 "${name}" 缺少右括号 ")"`);
        }
        consume(); // ')'
        const fn = customFunctions[name] || BUILTIN_FUNCTIONS[name];
        if (typeof fn !== 'function') {
          throw new Error(`未授权或不存在的函数: "${name}"`);
        }
        const out = Number(fn(...args));
        return Number.isFinite(out) ? out : 0;
      }
      return resolveDotPath(variables, name);
    }

    if (tok.type === 'punct' && tok.value === '(') {
      consume();
      const val = parseTernary();
      if (peek().type !== 'punct' || peek().value !== ')') {
        throw new SyntaxError('括号不匹配，缺少 ")"');
      }
      consume();
      return val;
    }

    throw new SyntaxError(`意外的公式标记: "${tok.value ?? 'EOF'}"`);
  }

  const result = parseTernary();
  if (peek().type !== 'eof') {
    throw new SyntaxError(`公式末尾存在多余标记: "${peek().value}"`);
  }
  return Number.isFinite(result) ? Number(result.toFixed(6)) : 0;
}

/**
 * Safely evaluate a mathematical / attribute formula without eval().
 * @param {string} expression
 * @param {Record<string, any>} [variables={}]
 * @param {Record<string, Function>} [customFunctions={}]
 */
export function evaluateFormula(expression, variables = {}, customFunctions = {}) {
  const trimmed = String(expression ?? '').trim();
  if (!trimmed) return 0;
  if (trimmed.length > 512) {
    throw new Error('公式长度超过安全上限（512 字符）');
  }
  const tokens = tokenizeFormula(trimmed);
  return parseAndEvalTokens(tokens, variables, customFunctions);
}

/**
 * Validate a formula expression without crashing.
 * @param {string} expression
 * @param {Record<string, any>} [sampleVariables={}]
 */
export function validateFormula(expression, sampleVariables = {}) {
  try {
    const value = evaluateFormula(expression, sampleVariables);
    return { valid: true, value, error: null };
  } catch (err) {
    return { valid: false, value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export class CalcEngine {
  constructor() {
    /** @type {Record<string, Function>} */
    this._customFunctions = {};
    /** @type {Map<string, Array<{ type: string, value: any }>>} */
    this._tokenCache = new Map();
  }

  registerFunction(name, fn) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || FORBIDDEN_KEYS.has(name)) {
      throw new Error(`非法自定义函数名: "${name}"`);
    }
    if (typeof fn !== 'function') {
      throw new TypeError('函数实现必须是 Function');
    }
    this._customFunctions[name] = fn;
    return this;
  }

  evaluate(expression, variables = {}) {
    const trimmed = String(expression ?? '').trim();
    if (!trimmed) return 0;
    if (trimmed.length > 512) {
      throw new Error('公式长度超过安全上限（512 字符）');
    }
    let tokens = this._tokenCache.get(trimmed);
    if (!tokens) {
      tokens = tokenizeFormula(trimmed);
      if (this._tokenCache.size > 200) {
        this._tokenCache.clear();
      }
      this._tokenCache.set(trimmed, tokens);
    }
    return parseAndEvalTokens(tokens, variables, this._customFunctions);
  }

  validate(expression, sampleVariables = {}) {
    try {
      const value = this.evaluate(expression, sampleVariables);
      return { valid: true, value, error: null };
    } catch (err) {
      return { valid: false, value: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  clamp(value, min, max) {
    return clamp(value, min, max);
  }

  roll(count = 1, sides = 6, modifier = 0, rng = Math.random) {
    return roll(count, sides, modifier, rng);
  }

  rollNotation(notation, rng = Math.random) {
    return rollNotation(notation, rng);
  }

  chanceCheck(probability, options) {
    return chanceCheck(probability, options);
  }

  weightedPick(items, weightFn, rng = Math.random) {
    return weightedPick(items, weightFn, rng);
  }

  stackStat(baseValue, modifiers = [], options = {}) {
    return computeStackedStat(baseValue, modifiers, options);
  }
}
