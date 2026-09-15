/**
 * components/feature-cards.js — AxData 特色短线指标卡片
 * 竞价昨比、开盘量比、开盘换手、开盘抢筹、自由流通市值。
 * Provider 不可用时优雅降级为占位提示（需求 5.3）。
 */

import { request, APIS } from '../api.js';
import { normalizeFeature } from '../normalize.js';
import { esc, fmtNum } from '../ui.js';

const CARD_DEFS = [
  { key: 'auctionYesterdayRatio', label: '竞价昨比', unit: '', icon: 'ri-auction-line', desc: '今日开盘成交量 ÷ 昨日开盘成交量，>1 为竞价显著放量' },
  { key: 'openVolumeRatio', label: '开盘量比', unit: '', icon: 'ri-scales-3-line', desc: '开盘成交量 ÷ 近5个完整交易日平均每分钟成交量，>1 为放量' },
  { key: 'openTurnover', label: '开盘换手Z', unit: '%', icon: 'ri-repeat-2-line', desc: '开盘时段成交量占自由流通股本（Z 口径）的比例，衡量筹码交换强度' },
  { key: 'openGrab', label: '开盘抢筹', unit: '%', icon: 'ri-hand-coin-line', desc: '开盘阶段主动买入强度指标，越高代表资金抢筹意愿越强' },
  { key: 'freeFloatMv', label: '自由流通市值Z', unit: '亿', icon: 'ri-funds-line', desc: '剔除限售与大股东长期持仓后的实际可交易市值（Z 口径）', scale: 1e-8 },
];

/** 单个指标卡片 */
function card(def, value) {
  let v = value != null && Number.isFinite(Number(value)) ? Number(value) : null;
  // 带换算系数的指标（如市值 元→亿）；若换算后过小而原值量级合理，则视为已是目标单位
  if (v != null && def.scale) {
    const scaled = v * def.scale;
    v = (scaled > 0 && scaled < 0.01 && v >= 0.01) ? v : scaled;
  }
  const has = v != null;
  return `
  <div class="card p-3.5 hover:border-slate-600 transition-colors">
    <div class="flex items-center gap-1.5 text-slate-400 text-xs mb-2" title="${esc(def.desc)}">
      <i class="${def.icon} text-indigo-400/80"></i>${esc(def.label)}
      <i class="ri-information-line text-slate-600 text-[10px] ml-auto cursor-help"></i>
    </div>
    ${has ? `
    <p class="text-xl font-bold tabular text-slate-100">${fmtNum(v, 2)}
      <span class="text-xs text-slate-500 font-normal">${def.unit}</span></p>
    <p class="text-[10px] text-slate-600 mt-1.5 leading-relaxed">${esc(def.desc)}</p>
    ` : `
    <p class="text-sm text-slate-500 py-1">字段缺失</p>
    <p class="text-[10px] text-amber-500/60 mt-1.5">该字段在返回数据中不存在，可能对应采集任务未启用</p>
    `}
  </div>`;
}

/**
 * 渲染特色指标卡片。
 * @param {HTMLElement} el 容器
 * @param {string} code 股票代码
 * @param {object|null} featureRow 已获取的原始行（可选，避免重复请求）
 */
export async function renderFeatureCards(el, code, featureRow = null) {
  if (!el) return;

  const skeleton = `
  <div class="card p-4">
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
        <i class="ri-flashlight-line text-amber-400"></i>AxData 特色短线指标 · ${esc(code || '')}
      </h3>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
      ${CARD_DEFS.map(d => `<div class="card !bg-slate-900/50 p-3.5">
        <div class="h-3 w-16 bg-slate-800 rounded pulse-soft mb-2.5"></div>
        <div class="h-6 w-20 bg-slate-800 rounded pulse-soft"></div>
      </div>`).join('')}
    </div>
  </div>`;
  el.innerHTML = skeleton;

  // 获取数据（传入已缓存的行或重新请求）
  let raw = featureRow;
  if (!raw) {
    try {
      const rows = await request(APIS.spotFeature, { code });
      if (Array.isArray(rows) && rows.length) raw = rows[0];
    } catch { /* Provider 不可用 */ }
  }

  if (!raw) {
    // 优雅降级：占位提示（需求 5.3）
    el.innerHTML = `
    <div class="card p-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
          <i class="ri-flashlight-line text-amber-400"></i>AxData 特色短线指标 · ${esc(code || '')}
        </h3>
      </div>
      <div class="rounded-lg border border-dashed border-slate-700 bg-slate-900/40 p-6 text-center">
        <i class="ri-plug-line text-2xl text-slate-600"></i>
        <p class="text-sm text-slate-400 mt-2">该数据源不可用</p>
        <p class="text-xs text-slate-600 mt-1 max-w-md mx-auto leading-relaxed">
          特色指标（竞价昨比 / 开盘量比 / 开盘换手 / 自由流通市值等）依赖 AxData 对应 Provider 插件。
          请确认已安装并启用相关采集任务，或在 <a href="#/config" class="text-indigo-400 underline">配置页</a> 检查服务连接。短线评分已在无该维度下计算。
        </p>
      </div>
    </div>`;
    return;
  }

  const f = normalizeFeature(raw);
  el.innerHTML = `
  <div class="card p-4">
    <div class="flex items-center justify-between mb-3 flex-wrap gap-1">
      <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
        <i class="ri-flashlight-line text-amber-400"></i>AxData 特色短线指标 · ${esc(code || '')}
      </h3>
      ${f.updated ? `<span class="text-[10px] text-slate-600">更新于 ${esc(f.updated)}</span>` : ''}
    </div>
    <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
      ${CARD_DEFS.map(d => card(d, f[d.key])).join('')}
    </div>
  </div>`;
}
