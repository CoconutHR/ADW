/**
 * api.js — AxData 数据适配层
 * 统一封装 HTTP 请求：POST /v1/request/{接口名}，携带 params 与 fields。
 * - 超时控制（默认 10s）
 * - 可读错误信息（含 Provider/接口名）
 * - 路径模板可配置（{api} 占位符）
 * - 演示数据模式拦截
 */

import { getConfig, saveConfig, isBaseUrlCustom } from './store.js';
import { getDemoData } from './demo-data.js';

/**
 * 日/周线复权参数：固定使用「定点前复权」并以最新交易日为锚。
 *
 * 背景（实测结论，2026-09）：AxData 的 `adjust=qfq` 由上游 TDX 行情服务器计算，
 * 该服务端采用「减法」——从原始价里逐笔扣减累计每股现金分红，而不是标准的乘法式
 * 复权因子。后果是长历史、高分红个股的早期 K 线价格为负：
 *   - 600519：6005 根日 K 中 3529 根为负（2001-08-27 ~ 2016-09-29），最负 -314.87
 *   - 抽检 6 只个股，5 只受影响（000001 / 000858 / 601398 / 600036 / 600519）
 *   - 即便为正也严重失真，例如 600519 在 2016-09-30 返回 6.25，标准前复权应为 241.33
 * 判据：纯现金分红日的价格跳变精确等于每股分红（2023-2026 年 6 次事件误差 < 0.01 元），
 * 即调整量是「减去」而非「乘以」。
 *
 * `adjust=fixed_qfq`（定点前复权，锚定最新交易日）走的是正确的乘法式实现：
 * 实测其结果与用 XDXR 事件独立复算的标准前复权值完全一致（600519 在 2001-08-27
 * 为 4.17，与独立复算一致；原始价 35.55），且抽检个股均无负值。故统一改用该模式。
 *
 * 注：anchor_date 仅在 adjust=fixed_qfq 时允许传入；传入晚于最后一根 K 线的日期时
 * AxData 会自动收敛到最后一根，因此直接用当天日期即可。
 */
export function klineAdjustParams() {
  const now = new Date();
  const ymd = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  return { adjust: 'fixed_qfq', anchor_date: ymd };
}

/** API 接口名注册表：与 AxData Provider Registry 真实接口一一对应（文档站 electkismet.github.io/AxData） */
export const APIS = {
  klineDaily: 'stock_kline_daily_tdx',              // 日K线（参数：code, adjust, anchor_date）
  klineWeekly: 'stock_kline_weekly_tdx',            // 周K线（参数：code, adjust, anchor_date）
  klineMinute: 'stock_kline_minute_tdx',            // 分钟K线（参数：code, period=1m/5m/15m/30m/60m, adjust）
  realtimeSnapshot: 'stock_realtime_snapshot_tdx',  // 实时快照（参数：code）
  spotFeature: 'stock_shortline_indicators_tdx',    // 短线指标（竞价昨比/开盘量比/开盘换手Z/开盘抢筹/流通市值Z）
  stockCodes: 'stock_codes_tdx',                    // 全市场证券代码-名称表（无必填参数，用于名称补全与按名称搜索）
  limitLadder: 'stock_limit_ladder_tdx',            // 连板天梯（参数：count, scope, include_touched, topic_type）
  themeStrength: 'stock_theme_strength_rank_tdx',   // 题材强度排行（参数：count, scope, topic_type）
};

/** 包装可读错误 */
export class ApiError extends Error {
  constructor(message, { api = '', status = 0, cause = null, kind = 'request' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.api = api;
    this.status = status;
    this.cause = cause;
    this.kind = kind; // 'request' | 'timeout' | 'network' | 'provider' | 'empty'
  }
}

/** 构建 URL：将模板中 {api} 替换为接口名 */
function buildUrl(baseUrl, pathTemplate, api) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  const path = (pathTemplate || '/v1/request/{api}').replace('{api}', api);
  return base + path;
}

/**
 * 从错误响应体提取可读文本。
 * FastAPI/AxData 的校验错误 detail 为 [{loc, msg, type}] 数组，
 * 直接字符串拼接会显示成 [object Object]，这里展开为「字段: 原因」的可读形式。
 */
function extractErrorDetail(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (Array.isArray(body.detail)) {
    return body.detail.map(d => {
      const msg = String((d && (d.msg || d.type)) || '校验失败');
      const loc = Array.isArray(d && d.loc) ? d.loc.filter(x => x !== 'body').join('.') : '';
      return loc ? `${loc}: ${msg}` : msg;
    }).join('；');
  }
  if (typeof body.detail === 'string') return body.detail;
  if (typeof body.message === 'string') return body.message;
  if (typeof body.error === 'string') return body.error;
  // AxData 真实错误结构：{success:false, error:{code, message}, meta:{next_action}}
  if (body.error && typeof body.error === 'object') {
    const code = body.error.code ? `[${body.error.code}] ` : '';
    const msg = String(body.error.message || body.error.detail || '未知错误');
    const action = (body.meta && typeof body.meta.next_action === 'string') ? `（建议：${body.meta.next_action}）` : '';
    return code + msg + action;
  }
  try { return JSON.stringify(body); } catch { return String(body); }
}

/**
 * 核心请求函数。
 * @param {string} api 接口名（如 APIS.klineDaily）
 * @param {object} params 请求参数（如 { code: '600519' }）
 * @param {array|null} fields 需要的字段列表（null 表示全部）
 * @param {object} extra { timeoutMs } 可覆盖超时
 * @returns {Promise<array|object>} rows 或 data
 */
export async function request(api, params = {}, fields = null, extra = {}) {
  let cfg = getConfig();

  // 演示数据模式：直接返回内置模拟数据
  if (cfg.demoMode) {
    return getDemoData(api, params);
  }

  // 先确保地址可用（不可用时自动切换到同源代理），再取配置发请求
  await ensureBaseUrl();
  cfg = getConfig();

  const url = buildUrl(cfg.baseUrl, cfg.pathTemplate, api);
  const timeoutMs = extra.timeoutMs || cfg.timeoutMs || 10000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params, fields: fields || undefined }),
      signal: ctrl.signal
    });

    if (!resp.ok) {
      let detail = '';
      try {
        detail = extractErrorDetail(await resp.json());
      } catch { /* 非 JSON 错误体 */ }
      // Provider 类错误：AxData 返回 4xx/5xx 且含接口上下文
      throw new ApiError(
        `接口 ${api} 请求失败（HTTP ${resp.status}）${detail ? '：' + detail : ''}`,
        { api, status: resp.status, kind: resp.status >= 400 ? 'provider' : 'request' }
      );
    }

    const data = await resp.json();

    // 兼容多种响应包裹结构：{rows:[]}/{data:[]}/{list:[]}/直接数组
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.rows)) return data.rows;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data.list)) return data.list;
    if (data && typeof data === 'object') return data;
    throw new ApiError(`接口 ${api} 返回了无法识别的数据结构`, { api, kind: 'empty' });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') {
      throw new ApiError(`请求 ${api} 超时（${timeoutMs / 1000}s），请检查 AxData 服务是否响应`, { api, kind: 'timeout' });
    }
    // TypeError: Failed to fetch —— 网络/CORS/混合内容
    throw new ApiError(
      `无法连接 ${url}（网络错误或跨域限制）。请确认 AxData 服务已启动，若页面与API非同源请在配置页查看 CORS 指引`,
      { api, cause: err, kind: 'network' }
    );
  } finally {
    clearTimeout(timer);
  }
}

let _baseUrlReady = null;

/**
 * 作废已缓存的地址解析结果。
 * 用户在配置页手工改了服务地址后必须调用，否则后续请求仍沿用旧地址。
 */
export function resetBaseUrlCache() {
  _baseUrlReady = null;
}

/**
 * 确保已解析出可用的 Base URL，结果在页面生命周期内缓存一次。
 *
 * AxData 自带 CORSMiddleware 且只放行白名单来源，面板直连 8666 时预检会被拒
 * （浏览器报 No 'Access-Control-Allow-Origin' header），表现为「连接失败」。
 * 因此在首次发起任何数据请求前，先确认当前地址可用；不可用时按候选列表
 * （页面自身 origin → 8666）探测并写回配置，避免视图抢先用失效地址发请求。
 *
 * @returns {Promise<string>} 可用的 Base URL
 */
export function ensureBaseUrl() {
  if (_baseUrlReady) return _baseUrlReady;
  _baseUrlReady = (async () => {
    const cfg = getConfig();
    if (cfg.demoMode) return cfg.baseUrl;
    const current = (cfg.baseUrl || '').replace(/\/+$/, '');

    // 用户未手工指定过地址：按候选优先级直接探测，不再先撞一次 8666 的 CORS 拒绝
    if (!isBaseUrlCustom()) {
      const found = await autoDetectBaseUrl();
      if (found) {
        if (found !== current) {
          saveConfig({ baseUrl: found });
          console.warn(`[AxData 时机面板] 已自动选用可用服务地址 ${found}`);
        }
        return found;
      }
      return current;
    }

    // 用户已手工指定：尊重其选择，仅在该地址失效时兜底切换
    if (await probeBaseUrl(current, 4000)) return current;
    const found = await autoDetectBaseUrl([current]);
    if (found) {
      saveConfig({ baseUrl: found });
      console.warn(`[AxData 时机面板] 原服务地址 ${current} 不可用，已自动切换到 ${found}`);
      return found;
    }
    return current;
  })();
  return _baseUrlReady;
}

/**
 * 候选 Base URL 列表（按优先级）。
 * 面板若由 server.py 托管，则页面自身的 origin 就是可用的同源代理，
 * 应优先于默认的 8666 —— 后者会因 AxData 的 CORS 白名单被拒。
 */
export function baseCandidates() {
  const list = [];
  try {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      list.push(location.origin);   // server.py 托管面板时，自身 origin 即同源代理
    }
  } catch { /* 非浏览器环境 */ }
  list.push('http://127.0.0.1:8080');  // 面板被其它静态服务器托管时，代理通常仍在此端口
  list.push('http://127.0.0.1:8666');  // AxData 直连（需其 CORS 放行面板来源）
  return list;
}

/** 对指定 Base URL 做一次健康检查，返回是否可用 */
export async function probeBaseUrl(baseUrl, timeoutMs = 4000) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  if (!base) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(base + '/health', { signal: ctrl.signal });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 自动探测可用的 Base URL。
 * @param {string[]} skip 需要排除的地址（通常是当前已失效的配置）
 * @returns {Promise<string|null>} 首个可用的地址，全部不可用时返回 null
 */
export async function autoDetectBaseUrl(skip = []) {
  for (const base of baseCandidates()) {
    if (skip.includes(base)) continue;
    if (await probeBaseUrl(base)) return base;
  }
  return null;
}

/**
 * 健康检查：GET /health（备用 /v1/status、/v1/doctor）
 *
 * @param {string|null} overrideBaseUrl 指定要检测的地址。传入时如实检测该地址、
 *   不触发自动切换，供配置页「测试连接」反馈用户填写的地址是否真的可用。
 */
export async function healthCheck(overrideBaseUrl = null) {
  const override = overrideBaseUrl ? overrideBaseUrl.replace(/\/+$/, '') : null;
  if (!override) await ensureBaseUrl();
  const cfg = getConfig();
  const base = override || (cfg.baseUrl || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 8000);
  try {
    const resp = await fetch(base + '/health', { signal: ctrl.signal });
    if (!resp.ok) {
      // 代理层（server.py）返回的 502/504 带 {error, hint}，透传具体原因
      let reason = `健康检查返回 HTTP ${resp.status}`;
      try {
        const body = await resp.json();
        if (body && (body.error || body.hint)) {
          reason = [body.error, body.hint].filter(Boolean).join('；');
        }
      } catch { /* 非 JSON 错误体，保留默认 reason */ }
      return { ok: false, reason };
    }
    const body = await resp.json().catch(() => ({}));
    return { ok: true, body };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, reason: '健康检查超时（服务未响应）' };
    return { ok: false, reason: '网络错误或跨域限制（CORS），无法访问 ' + base };
  } finally {
    clearTimeout(timer);
  }
}
