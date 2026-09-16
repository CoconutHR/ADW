/**
 * views/stock.js — 个股分析视图
 * - 代码搜索 + 周期切换（日/周/分钟）
 * - 实时快照条
 * - K线主图 + 成交量副图 + MA/MACD/KDJ/BOLL 叠加开关 + 信号标注
 * - 信号侧栏（触发理由）
 * - 五维评分面板（score-panel 组件）
 * - 特色短线指标卡片（feature-cards 组件）
 */

import { request, APIS, klineAdjustParams } from '../api.js';
import { ensureNames, getName, resolveCode, stockLabel } from '../names.js';
import { normalizeKlines, normalizeSnapshot } from '../normalize.js';
import { computeAll } from '../indicators.js';
import { detectSignals, recentSignals, summarizeSignals } from '../signal.js';
import { createKlineChart } from '../components/kline-chart.js';
import { renderScorePanel } from '../components/score-panel.js';
import { renderFeatureCards } from '../components/feature-cards.js';
import { getWatchlist, addWatch, removeWatch, getLastStock, setLastStock } from '../store.js';
import { toast, loadingHTML, errorHTML, emptyHTML, esc, fmtAmount, fmtNum } from '../ui.js';

const PERIODS = [
  { key: 'daily', label: '日线', api: APIS.klineDaily, params: klineAdjustParams() },
  { key: 'weekly', label: '周线', api: APIS.klineWeekly, params: klineAdjustParams() },
  // 分钟线历史较短、分红影响可忽略，且复权对盘口细节无意义，保持不复权
  { key: 'minute', label: '分钟线', api: APIS.klineMinute, params: { period: '5m', adjust: 'none' } },
];

export function registerStockView(registerRoute) {
  registerRoute('/stock', (ctx) => mount(ctx, null));
  registerRoute('/stock/:code', (ctx) => mount(ctx, ctx.params.code));
}

async function mount(ctx, codeParam) {
  const code = codeParam || getLastStock() || '600519';
  setLastStock(code);

  const state = {
    code,
    period: 'daily',
    klines: [],
    indicators: null,
    signals: [],
    snapshot: null,
    feature: null,
    overlays: { ma: true, boll: false, macd: false, kdj: false },
    loading: false,
    error: null,
  };

  ctx.container.innerHTML = buildSkeleton();
  bindStaticEvents(ctx, state);
  renderWatchSelect(ctx, state);

  await loadStock(ctx, state);

  // 名称目录就绪后补全标题与自选下拉（首屏渲染时目录可能尚未加载完）
  ensureNames().then(() => {
    renderWatchSelect(ctx, state);
    updateChartTitle(ctx, state);
  });

  ctx.onCleanup(() => {
    window.removeEventListener('resize', state._resizeHandler);
    if (state._chart) state._chart.dispose();
  });
}

function buildSkeleton() {
  return `
  <div class="space-y-4">

    <!-- 搜索与快照条 -->
    <div class="card p-4">
      <div class="flex flex-wrap items-center gap-3">
        <div class="flex items-center gap-2">
          <div class="relative">
            <input id="stock-input" class="field w-44 pl-8" placeholder="代码或名称" spellcheck="false">
            <i class="ri-search-line absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm"></i>
          </div>
          <button id="stock-search" class="btn btn-primary"><i class="ri-search-line"></i>查询</button>
        </div>
        <select id="watch-select" class="field !w-auto !py-1.5 text-xs" title="从自选股快速切换"></select>
        <div id="period-tabs" class="flex items-center rounded-lg bg-slate-800 border border-slate-700 p-0.5">
          ${PERIODS.map(p => `<button data-period="${p.key}" class="px-3 py-1 text-xs rounded-md text-slate-400 transition-colors ${p.key === 'daily' ? 'bg-indigo-600 text-white' : 'hover:text-slate-200'}">${p.label}</button>`).join('')}
        </div>
        <button id="watch-toggle" class="btn btn-ghost text-xs" title="加入/移除自选">
          <i class="ri-star-line"></i><span>加自选</span>
        </button>
        <div id="snapshot-bar" class="flex-1 min-w-0"></div>
      </div>
    </div>

    <!-- 图表 + 信号侧栏 -->
    <div class="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <div class="xl:col-span-2 card p-4 min-w-0">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
            <i class="ri-candle-line text-indigo-400"></i>
            <span id="chart-title">K线</span>
          </h3>
          <div id="overlay-toggles" class="flex items-center gap-1.5">
            ${['ma', 'boll', 'macd', 'kdj'].map(key => {
              const on = key === 'ma';
              return `<button data-overlay="${key}" class="px-2.5 py-1 text-xs rounded-md border transition-colors ${on ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'}">${key.toUpperCase()}</button>`;
            }).join('')}
          </div>
        </div>
        <div id="chart-box" class="chart-box" style="height:460px"></div>
      </div>

      <div class="card p-4 min-w-0 flex flex-col">
        <h3 class="font-medium text-slate-200 text-sm mb-3 flex items-center gap-1.5 shrink-0">
          <i class="ri-flashlight-line text-amber-400"></i>近期信号
          <span id="signal-count" class="text-xs text-slate-500 font-normal"></span>
        </h3>
        <div id="signal-list" class="flex-1 overflow-y-auto pr-1 space-y-2" style="max-height:480px"></div>
      </div>
    </div>

    <!-- 五维评分 -->
    <div id="score-panel"></div>

    <!-- 特色指标 -->
    <div id="feature-cards"></div>
  </div>`;
}

function bindStaticEvents(ctx, state) {
  const $ = (id) => ctx.container.querySelector('#' + id);

  // 查询：支持 6 位代码，也支持名称（由名称目录解析为代码）
  const doSearch = async () => {
    const v = $('stock-input').value.trim();
    if (!v) return;
    if (/^\d{6}$/.test(v)) { location.hash = `#/stock/${v}`; return; }
    await ensureNames();
    const code = resolveCode(v);
    if (!code) { toast(`未找到「${v}」，可改用 6 位代码查询`, 'warn'); return; }
    location.hash = `#/stock/${code}`;
  };
  $('stock-search').addEventListener('click', doSearch);
  $('stock-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // 自选下拉：选择后直接跳转
  $('watch-select').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v) location.hash = `#/stock/${v}`;
  });

  // 周期切换
  $('period-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-period]');
    if (!btn || state.loading) return;
    state.period = btn.dataset.period;
    ctx.container.querySelectorAll('#period-tabs [data-period]').forEach(b => {
      const active = b.dataset.period === state.period;
      b.className = `px-3 py-1 text-xs rounded-md transition-colors ${active ? 'bg-indigo-600 text-white' : 'hover:text-slate-200 text-slate-400'}`;
    });
    loadStock(ctx, state);
  });

  // 指标叠加开关（无需重新拉数，重算渲染）
  $('overlay-toggles').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-overlay]');
    if (!btn) return;
    const key = btn.dataset.overlay;
    state.overlays[key] = !state.overlays[key];
    btn.className = `px-2.5 py-1 text-xs rounded-md border transition-colors ${state.overlays[key] ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'}`;
    renderChart(ctx, state);
  });

  // 自选切换
  $('watch-toggle').addEventListener('click', () => {
    const label = stockLabel(state.code, state.snapshot?.name);
    const list = getWatchlist();
    if (list.some(x => x.code === state.code)) {
      removeWatch(state.code);
      toast(`已从自选移除 ${label}`, 'info');
    } else {
      addWatch(state.code, state.snapshot?.name || getName(state.code) || state.code);
      toast(`已加入自选 ${label}`, 'success');
    }
    updateWatchBtn(ctx, state);
    renderWatchSelect(ctx, state);
  });

  // 图表自适应
  state._resizeHandler = () => state._chart && state._chart.resize();
  window.addEventListener('resize', state._resizeHandler);
}

/** 图表标题：「名称 代码 · 周期」，名称目录未就绪时先只显示代码 */
function updateChartTitle(ctx, state) {
  const el = ctx.container.querySelector('#chart-title');
  if (!el) return;
  const periodDef = PERIODS.find(p => p.key === state.period);
  el.textContent = `${stockLabel(state.code)} · ${periodDef ? periodDef.label : ''}`;
}

/** 自选股下拉：显示「名称 代码」，无自选时给出占位提示 */
function renderWatchSelect(ctx, state) {
  const sel = ctx.container.querySelector('#watch-select');
  if (!sel) return;
  const list = getWatchlist();

  if (!list.length) {
    sel.innerHTML = `<option value="">自选股（空）</option>`;
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = `<option value="">自选股…</option>` +
    list.map(w => {
      const label = stockLabel(w.code, w.name);
      const selected = w.code === state.code ? ' selected' : '';
      return `<option value="${esc(w.code)}"${selected}>${esc(label)}</option>`;
    }).join('');
}

function updateWatchBtn(ctx, state) {
  const btn = ctx.container.querySelector('#watch-toggle');
  if (!btn) return;
  const inList = getWatchlist().some(x => x.code === state.code);
  btn.innerHTML = inList
    ? `<i class="ri-star-fill text-amber-400"></i><span>已自选</span>`
    : `<i class="ri-star-line"></i><span>加自选</span>`;
}

/** 拉取数据主流程 */
async function loadStock(ctx, state) {
  const $ = (id) => ctx.container.querySelector('#' + id);
  const chartBox = $('chart-box');
  const periodDef = PERIODS.find(p => p.key === state.period);

  state.loading = true;
  state.error = null;
  chartBox.innerHTML = loadingHTML(`正在拉取 ${stockLabel(state.code)} ${periodDef.label}数据…`, '440px');
  updateChartTitle(ctx, state);

  // K 线（核心数据，失败则展示错误）
  try {
    const rows = await request(periodDef.api, { code: state.code, ...(periodDef.params || {}) });
    state.klines = normalizeKlines(rows).slice(-260);
    if (!state.klines.length) {
      throw new Error('EMPTY');
    }
  } catch (err) {
    state.loading = false;
    if (err && err.message === 'EMPTY') {
      chartBox.innerHTML = emptyHTML('该股票在当前周期无K线数据（可能未采集或代码不存在）', 'ri-bar-chart-2-line');
    } else {
      const apiName = err.api || periodDef.api;
      chartBox.innerHTML = errorHTML(
        `K线数据拉取失败（接口 ${esc(apiName)}）`,
        esc(err.message || String(err)),
        `data-action="retry-kline"`
      );
      chartBox.querySelector('[data-action="retry-kline"]')?.addEventListener('click', () => loadStock(ctx, state));
    }
    // 侧栏与评分同步清空
    $('signal-list').innerHTML = emptyHTML('等待K线数据…');
    renderScorePanel($('score-panel'), null, { code: state.code, name: stockLabel(state.code), reason: 'K线数据不可用' });
    renderFeatureCards($('feature-cards'), state.code);
    return;
  }

  // 指标与信号计算
  state.indicators = computeAll(state.klines);
  const det = detectSignals(state.klines, { indicators: state.indicators });
  state.signals = det.signals;

  // 实时快照（非核心，失败静默降级）
  try {
    const snapRows = await request(APIS.realtimeSnapshot, { code: state.code });
    if (Array.isArray(snapRows) && snapRows.length) state.snapshot = normalizeSnapshot(snapRows[0]);
  } catch { state.snapshot = null; }

  // 特色指标（非核心，失败静默降级）
  try {
    const featRows = await request(APIS.spotFeature, { code: state.code });
    if (Array.isArray(featRows) && featRows.length) state.feature = featRows[0];
  } catch { state.feature = null; }

  state.loading = false;

  // 渲染各区域
  renderSnapshotBar(ctx, state);
  renderChart(ctx, state);
  renderSignalList(ctx, state);
  updateWatchBtn(ctx, state);
  renderWatchSelect(ctx, state);
  renderScorePanel($('score-panel'), state, { code: state.code, name: stockLabel(state.code), feature: state.feature });
  renderFeatureCards($('feature-cards'), state.code, state.feature);
}

/** 快照条 */
function renderSnapshotBar(ctx, state) {
  const bar = ctx.container.querySelector('#snapshot-bar');
  const s = state.snapshot;
  const last = state.klines[state.klines.length - 1];
  const prev = state.klines[state.klines.length - 2] || last;

  const price = s?.price ?? last?.close ?? null;
  const pct = s?.changePct ?? (price != null && prev?.close ? ((price - prev.close) / prev.close) * 100 : null);
  const cls = pct > 0 ? 'text-rise' : pct < 0 ? 'text-fall' : 'text-slate-300';

  const items = [
    { label: '最新价', value: price != null ? fmtNum(price) : '--', cls: cls + ' font-bold text-lg' },
    { label: '涨跌幅', value: pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '--', cls },
    { label: '今开', value: fmtNum(s?.open ?? last?.open) },
    { label: '最高', value: fmtNum(s?.high ?? last?.high), cls: 'text-rise' },
    { label: '最低', value: fmtNum(s?.low ?? last?.low), cls: 'text-fall' },
    { label: '成交量', value: s?.volume != null ? fmtAmount(s.volume) : (last?.volume != null ? fmtAmount(last.volume) : '--') },
    { label: '成交额', value: s?.amount != null ? fmtAmount(s.amount) : (last?.amount != null ? fmtAmount(last.amount) : '--') },
  ];

  bar.innerHTML = `
    <div class="flex items-baseline gap-1 mr-3 shrink-0">
      <span class="font-bold text-slate-100">${esc(s?.name || (state.feature && state.feature.name) || getName(state.code) || state.code)}</span>
      <span class="text-xs text-slate-500 font-mono">${esc(state.code)}</span>
    </div>
    <div class="flex items-center gap-4 overflow-x-auto no-scrollbar flex-wrap">
      ${items.map(it => `<div class="flex items-baseline gap-1.5 shrink-0">
        <span class="text-[11px] text-slate-500">${it.label}</span>
        <span class="text-sm tabular ${it.cls || 'text-slate-200'}">${it.value}</span>
      </div>`).join('')}
    </div>
    ${!s ? `<span class="text-[10px] text-slate-600 shrink-0 ml-1" title="实时快照接口不可用，展示K线最新数据">*快照降级</span>` : ''}`;
}

/** 图表 */
function renderChart(ctx, state) {
  const box = ctx.container.querySelector('#chart-box');
  if (!state.klines.length) return;
  box.innerHTML = '';

  const recent = recentSignals(state.signals, state.klines.length, 60);
  if (!state._chart) {
    state._chart = createKlineChart(box, {
      klines: state.klines, indicators: state.indicators,
      signals: recent, overlays: state.overlays
    });
  } else {
    // dispose 后重建（副图数量可能变化）
    state._chart.dispose();
    state._chart = createKlineChart(box, {
      klines: state.klines, indicators: state.indicators,
      signals: recent, overlays: state.overlays
    });
  }
}

/** 信号侧栏 */
function renderSignalList(ctx, state) {
  const listEl = ctx.container.querySelector('#signal-list');
  const countEl = ctx.container.querySelector('#signal-count');
  const recent = recentSignals(state.signals, state.klines.length, 30);
  const sum = summarizeSignals(recent);

  countEl.textContent = `· 近30根 ${sum.bull}多 / ${sum.bear}空`;

  if (!recent.length) {
    listEl.innerHTML = emptyHTML('近30根K线内无信号触发', 'ri-checkbox-blank-circle-line');
    return;
  }

  // 最近的在前
  const items = [...recent].reverse();
  listEl.innerHTML = items.map(s => `
    <div class="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5 row-hover">
      <div class="flex items-center justify-between gap-2">
        <span class="badge ${s.direction === 'bullish' ? 'bg-rose-950 text-rose-300 border border-rose-900' : 'bg-emerald-950 text-emerald-300 border border-emerald-900'}">
          <i class="${s.direction === 'bullish' ? 'ri-arrow-up-line' : 'ri-arrow-down-line'}"></i>${esc(s.label)}
        </span>
        <span class="text-[11px] text-slate-500 tabular">${esc(s.date)} · ${fmtNum(s.price)}</span>
      </div>
      <p class="text-xs text-slate-400 mt-1.5 leading-relaxed">${esc(s.reason)}</p>
    </div>`).join('');
}
