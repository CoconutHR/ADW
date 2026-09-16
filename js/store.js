/**
 * store.js — 本地存储工具
 * 封装配置与自选股的读写，带版本化 key 与 JSON 容错。
 */

/** 面板版本：配置页徽标与控制台启动日志展示，用于核验浏览器运行的代码是否为最新 */
export const APP_VERSION = 'v1.3.1';

const PREFIX = 'axpanel:';
const KEY_CONFIG = `${PREFIX}config`;
const KEY_WATCHLIST = `${PREFIX}watchlist`;
const KEY_LAST_STOCK = `${PREFIX}lastStock`;
const KEY_BASE_CUSTOM = `${PREFIX}baseUrlCustom`;

/** 默认配置（需求 1.1：默认 Base URL，路径模板可覆盖） */
const DEFAULT_CONFIG = {
  baseUrl: 'http://127.0.0.1:8666',
  pathTemplate: '/v1/request/{api}',   // 请求路径模板，{api} 为接口名占位
  timeoutMs: 10000,
  demoMode: false                       // 演示数据模式开关
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const val = JSON.parse(raw);
    return (val && typeof val === 'object') ? val : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 存储满/隐私模式时静默失败 */ }
}

/** 读取配置（与默认值合并，保证向后兼容新增字段） */
export function getConfig() {
  const saved = readJson(KEY_CONFIG, {});
  return { ...DEFAULT_CONFIG, ...saved };
}

/** 保存配置 */
export function saveConfig(patch) {
  const next = { ...getConfig(), ...patch };
  writeJson(KEY_CONFIG, next);
  return next;
}

/**
 * 用户是否在配置页手工指定过服务地址。
 *
 * 用于区分两种情形：
 *   - 未手工指定：Base URL 仍是内置默认值，启动时按优先级自动探测（同源代理优先），
 *     避免先向 8666 发一次注定被 CORS 拒绝的请求；
 *   - 已手工指定：以用户填写的地址为准，探测仅用于在其失效时兜底切换。
 */
export function isBaseUrlCustom() {
  try { return localStorage.getItem(KEY_BASE_CUSTOM) === '1'; } catch { return false; }
}

/** 标记用户已手工指定服务地址 */
export function markBaseUrlCustom() {
  try { localStorage.setItem(KEY_BASE_CUSTOM, '1'); } catch { /* ignore */ }
}

/** 读取自选股列表 [{code, name, addedAt}] */
export function getWatchlist() {
  const list = readJson(KEY_WATCHLIST, []);
  return Array.isArray(list) ? list.filter(x => x && typeof x.code === 'string') : [];
}

/** 保存自选股列表 */
export function saveWatchlist(list) {
  writeJson(KEY_WATCHLIST, Array.isArray(list) ? list : []);
}

/** 增加自选股，成功返回 true；已存在返回 false */
export function addWatch(code, name = '') {
  const code_ = String(code).trim();
  if (!code_) return false;
  const list = getWatchlist();
  if (list.some(x => x.code === code_)) return false;
  list.push({ code: code_, name: name || code_, addedAt: Date.now() });
  saveWatchlist(list);
  return true;
}

/** 删除自选股 */
export function removeWatch(code) {
  const list = getWatchlist();
  saveWatchlist(list.filter(x => x.code !== code));
}

/** 记住/读取最近浏览的个股代码 */
export function getLastStock() {
  try { return localStorage.getItem(KEY_LAST_STOCK) || ''; } catch { return ''; }
}
export function setLastStock(code) {
  try { localStorage.setItem(KEY_LAST_STOCK, code); } catch { /* ignore */ }
}
