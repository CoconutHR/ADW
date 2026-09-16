/**
 * names.js — 证券名称目录
 *
 * AxData 的实时快照、K 线、短线指标等接口均不带证券名称（实测 stock_realtime_snapshot_tdx
 * 无 name 字段），因此界面上只能显示代码。这里用 `stock_codes_tdx` 拉一次全市场
 * 代码-名称表（约 5500 条 / 100KB），缓存在 localStorage，供各处把代码补全为
 * 「名称 代码」，并支撑按名称搜索。
 *
 * 设计要点：
 * - 懒加载 + 单次飞行（inflight）：多处同时调用只发一次请求
 * - 缓存 24 小时，跨页面/刷新复用；写入失败（隐私模式/超限）时降级为内存缓存
 * - 所有取用路径都可失败：拿不到名称时退回代码，不阻塞界面
 */

import { request, APIS } from './api.js';
import { esc } from './ui.js';

const CACHE_KEY = 'axpanel:nameDir';
const CACHE_TTL = 24 * 60 * 60 * 1000;

let mem = null;         // { code: name }，内存副本
let inflight = null;    // 进行中的加载 Promise，避免重复请求
let cacheTried = false; // 是否已尝试读取本地缓存

/**
 * 名称规范化：TDX 会在名称里插空格做对齐（如「五 粮 液」「深 赛 格」，实测 36 条），
 * 展示与搜索都必须去掉，否则用户按「五粮液」搜不到。
 */
function normName(v) {
  return String(v ?? '').replace(/\s+/g, '').trim();
}

function readCache() {
  if (cacheTried) return mem;
  cacheTried = true;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.data !== 'object' || !obj.data) return null;
    if (typeof obj.ts !== 'number' || Date.now() - obj.ts > CACHE_TTL) return null;
    mem = obj.data;
    return mem;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* 存储不可用/超限：内存副本仍然有效 */ }
}

/**
 * 确保名称目录已加载。
 * @param {boolean} force 忽略缓存强制刷新
 * @returns {Promise<object>} code -> name 映射（失败时返回空对象）
 */
export async function ensureNames(force = false) {
  if (mem && !force) return mem;
  if (!force && readCache()) return mem;

  if (!inflight) {
    inflight = (async () => {
      try {
        const rows = await request(APIS.stockCodes, {}, null, { timeoutMs: 30000 });
        const data = {};
        for (const r of rows || []) {
          const code = String(r.symbol ?? r.code ?? '').trim();
          const name = normName(r.name);
          if (/^\d{6}$/.test(code) && name) data[code] = name;
        }
        if (Object.keys(data).length) {
          mem = data;
          writeCache(data);
        }
      } catch {
        // 目录不可用时保持 null；调用方一律按「无名称」处理
      } finally {
        inflight = null;
      }
      return mem || {};
    })();
  }
  return inflight;
}

/** 取名称（未加载时返回空串） */
export function getName(code) {
  if (!code) return '';
  if (!mem && !cacheTried) readCache();
  return (mem && mem[code]) || '';
}

/** 目录是否已就绪（用于决定要不要提示"正在加载名称"） */
export function namesReady() {
  if (!mem && !cacheTried) readCache();
  return !!mem;
}

/**
 * 按关键字搜索：代码前缀优先，其次名称包含。
 * @param {string} q 关键字
 * @param {number} limit 返回条数
 * @returns {Array<{code:string,name:string}>}
 */
export function searchStocks(q, limit = 12) {
  const kw = normName(q);
  if (!kw) return [];
  if (!mem && !cacheTried) readCache();
  if (!mem) return [];

  const entries = Object.keys(mem);
  const codeHits = [];
  const nameHits = [];
  for (const code of entries) {
    const name = mem[code];
    if (code.startsWith(kw)) codeHits.push({ code, name });
    else if (name.includes(kw)) nameHits.push({ code, name });
    if (codeHits.length >= limit && nameHits.length >= limit) break;
  }
  // 名称完全相同的排在前面，便于输入"茅台"直接命中
  nameHits.sort((a, b) => a.name.length - b.name.length || a.code.localeCompare(b.code));
  return [...codeHits, ...nameHits].slice(0, limit);
}

/**
 * 把用户输入解析为 6 位代码。
 * - 6 位数字：原样返回
 * - 其它：先精确匹配名称，再在目录中做包含匹配；命中唯一则返回代码，否则返回 null
 * @returns {string|null}
 */
export function resolveCode(input) {
  const raw = String(input ?? '');
  const kw = normName(raw);
  if (!kw) return null;
  if (/^\d{6}$/.test(kw)) return kw;
  if (!mem && !cacheTried) readCache();
  if (!mem) return null;

  const exact = Object.keys(mem).filter(c => mem[c] === kw);
  if (exact.length === 1) return exact[0];

  const hits = searchStocks(kw, 20);
  return hits.length ? hits[0].code : null;
}

/**
 * 「名称 + 代码」展示 HTML。
 * @param {string} code 6 位代码
 * @param {string} name 已知名称（缺省时从目录补全）
 * @param {object} opts { link:boolean, nameCls:string, codeCls:string }
 */
export function stockLabelHTML(code, name, opts = {}) {
  const cd = String(code ?? '');
  // name 等于代码说明当初没解析出名称，须回退到目录
  const nm = (name && name !== cd) ? normName(name) : getName(cd);
  const nameCls = opts.nameCls || 'text-slate-200';
  const codeCls = opts.codeCls || 'text-slate-600 font-mono text-[10px]';

  const inner = (nm && nm !== cd)
    ? `<span class="${nameCls}">${esc(nm)}</span> <span class="${codeCls}">${esc(cd)}</span>`
    : `<span class="${nameCls} font-mono">${esc(cd || nm)}</span>`;

  if (opts.link === false || !cd) return inner;
  const cls = opts.linkCls || 'hover:text-indigo-300';
  return `<a href="#/stock/${encodeURIComponent(cd)}" class="${cls}">${inner}</a>`;
}

/** 纯文本版「名称 代码」，用于 select/option、标题等 */
export function stockLabel(code, name) {
  const cd = String(code ?? '');
  const nm = (name && name !== cd) ? normName(name) : getName(cd);
  return (nm && nm !== cd) ? `${nm} ${cd}` : (cd || nm);
}

/**
 * 回填自选股中缺失的名称。
 * 早期版本按代码添加时 name 就等于 code，目录就绪后把它们补成真实名称。
 * @param {Array} list 自选列表（会被就地修改）
 * @returns {boolean} 是否发生了变更（需要调用方持久化/重绘）
 */
export function backfillWatchNames(list) {
  if (!Array.isArray(list) || !list.length) return false;
  let changed = false;
  for (const w of list) {
    if (!w || !w.code) continue;
    if (!w.name || w.name === w.code) {
      const nm = getName(w.code);
      if (nm) { w.name = nm; changed = true; }
    }
  }
  return changed;
}

/** 清空缓存（配置页可用于强制刷新目录） */
export function clearNameCache() {
  mem = null;
  cacheTried = false;
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}
