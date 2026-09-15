/**
 * views/backtest.js — 历史信号回验页（任务10）
 * - 回验参数表单：股票代码、时间区间、信号类型（多选）、方向、持有天数 N
 * - 统计指标卡：触发次数、有效样本、胜率、平均/中位收益、最大单笔亏损/盈利
 * - 收益分布直方图（ECharts 按需引入）
 * - 明细表（时间/收益排序）
 * - 数据不足明确提示、样本量说明、小样本警示（需求 7.1~7.4）
 */

import echarts from '../echarts.js';
import { request, APIS } from '../api.js';
import { normalizeKlines } from '../normalize.js';
import { SIGNAL_LABELS, SIGNAL_TYPE_DIRECTIONS } from '../signal.js';
import { runBacktest, bucketDistribution, MIN_SAMPLE_WARN, HOLD_MIN, HOLD_MAX } from '../backtest-engine.js';
import { getWatchlist, getLastStock } from '../store.js';
import { toast, loadingHTML, emptyHTML, errorHTML, esc, fmtNum, fmtPct } from '../ui.js';

/** 信号类型清单（按方向分组） */
const TYPE_GROUPS = [
  {
    direction: 'bullish',
    title: '看多信号',
    cls: 'text-rose-300',
    icon: 'ri-arrow-up-line',
    types: Object.keys(SIGNAL_TYPE_DIRECTIONS).filter(t => SIGNAL_TYPE_DIRECTIONS[t] === 'bullish'),
  },
  {
    direction: 'bearish',
    title: '看空信号',
    cls: 'text-emerald-300',
    icon: 'ri-arrow-down-line',
    types: Object.keys(SIGNAL_TYPE_DIRECTIONS).filter(t => SIGNAL_TYPE_DIRECTIONS[t] === 'bearish'),
  },
];

/** 直方图分桶配色：负收益绿、正收益红、近零区中性（A股红涨绿跌） */
function bucketColor(idx) {
  if (idx <= 3) return '#16a34a';        // < -2% 明确亏损
  if (idx === 4) return '#3f6212';       // -2~0%
  if (idx === 5) return '#7f1d1d';       // 0~2%
  return '#ef4444';                      // ≥2% 明确盈利
}

export function registerBacktestView(registerRoute) {
  registerRoute('/backtest', async (ctx) => {
    const state = {
      running: false,
      result: null,
      sortMode: 'time-desc',
      chart: null,
      params: {
        code: getLastStock() || '600519',
        startDate: '',
        endDate: '',
        holdDays: 5,
        direction: 'all',
        types: Object.keys(SIGNAL_LABELS),  // 默认全部信号类型
      },
    };

    ctx.container.innerHTML = buildSkeleton(state);
    bindEvents(ctx, state);

    ctx.onCleanup(() => {
      window.removeEventListener('resize', state._resizeHandler);
      if (state.chart) { state.chart.dispose(); state.chart = null; }
    });
  });
}

/** 页面骨架 */
function buildSkeleton(state) {
  return `
  <div class="space-y-4">

    <!-- 参数表单 -->
    <div class="card p-4">
      <h3 class="font-medium text-slate-200 text-sm mb-3 flex items-center gap-1.5">
        <i class="ri-history-line text-indigo-400"></i>回验参数
        <span class="text-xs text-slate-500 font-normal">信号触发后 N 个交易日的收益统计</span>
      </h3>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <!-- 股票代码 -->
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">股票代码</label>
          <div class="relative">
            <input id="bt-code" class="field pl-8 font-mono" value="${esc(state.params.code)}" maxlength="6" placeholder="6位数字" spellcheck="false">
            <i class="ri-search-line absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-sm"></i>
          </div>
        </div>
        <!-- 起始日期 -->
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">起始日期 <span class="text-slate-600">（空=不限）</span></label>
          <input id="bt-start" type="date" class="field" style="color-scheme:dark" value="${esc(state.params.startDate)}">
        </div>
        <!-- 结束日期 -->
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">结束日期 <span class="text-slate-600">（空=不限）</span></label>
          <input id="bt-end" type="date" class="field" style="color-scheme:dark" value="${esc(state.params.endDate)}">
        </div>
        <!-- 持有天数 -->
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">持有天数 N（交易日）</label>
          <div class="flex items-center gap-2">
            <input id="bt-hold" type="number" class="field w-24 tabular" min="${HOLD_MIN}" max="${HOLD_MAX}" value="${state.params.holdDays}">
            <div class="flex gap-1">
              ${[1, 3, 5, 10, 20].map(n => `<button data-hold="${n}" class="px-2 py-1 text-xs rounded-md border border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors tabular">${n}日</button>`).join('')}
            </div>
          </div>
        </div>
      </div>

      <!-- 方向 + 信号类型 -->
      <div class="mt-3 grid grid-cols-1 lg:grid-cols-4 gap-3">
        <div>
          <label class="block text-xs text-slate-500 mb-1.5">信号方向</label>
          <div id="bt-direction" class="flex items-center rounded-lg bg-slate-800 border border-slate-700 p-0.5 w-fit">
            ${[['all', '全部'], ['bullish', '仅看多'], ['bearish', '仅看空']].map(([v, l]) =>
              `<button data-dir="${v}" class="px-3 py-1 text-xs rounded-md transition-colors ${v === 'all' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}">${l}</button>`).join('')}
          </div>
        </div>

        ${TYPE_GROUPS.map(g => `
        <div>
          <label class="block text-xs text-slate-500 mb-1.5 ${g.cls}">
            <i class="${g.icon}"></i>${g.title}
            <button data-toggle-group="${g.direction}" class="ml-1 text-slate-600 hover:text-indigo-300 transition-colors" title="全选/清空本组">切换</button>
          </label>
          <div class="flex flex-wrap gap-x-3 gap-y-1.5" data-group="${g.direction}">
            ${g.types.map(t => `
            <label class="flex items-center gap-1 text-xs text-slate-300 cursor-pointer select-none hover:text-slate-100">
              <input type="checkbox" data-type="${t}" checked class="accent-indigo-500 w-3.5 h-3.5 cursor-pointer">
              ${SIGNAL_LABELS[t]}
            </label>`).join('')}
          </div>
        </div>`).join('')}
      </div>

      <!-- 运行按钮 + 自选快捷 -->
      <div class="mt-4 flex items-center justify-between flex-wrap gap-2">
        <button id="bt-run" class="btn btn-primary text-sm"><i class="ri-play-line"></i>运行回验</button>
        <div id="bt-watch-quick" class="flex items-center gap-1.5 flex-wrap">
          <span class="text-xs text-slate-600">自选快捷：</span>
          ${renderWatchQuick()}
        </div>
      </div>
    </div>

    <!-- 结果区 -->
    <div id="bt-result">
      ${emptyHTML('设置参数后点击「运行回验」，统计历史信号触发后 N 日的实际收益表现', 'ri-history-line')}
    </div>
  </div>`;
}

/** 自选快捷标签 */
function renderWatchQuick() {
  const list = getWatchlist().slice(0, 8);
  if (!list.length) return `<span class="text-xs text-slate-600">暂无自选（可在自选扫描页添加）</span>`;
  return list.map(w => `
    <button data-quick-code="${esc(w.code)}" class="px-2 py-0.5 text-xs rounded-md border border-slate-800 bg-slate-900 text-slate-400 hover:text-indigo-300 hover:border-slate-600 transition-colors" title="回验 ${esc(w.name)}">
      ${esc(w.name || w.code)}
    </button>`).join('');
}

/** 事件绑定 */
function bindEvents(ctx, state) {
  const $ = (id) => ctx.container.querySelector('#' + id);

  // 运行回验
  $('bt-run').addEventListener('click', () => runBacktestFlow(ctx, state));

  // 持有天数快捷
  ctx.container.querySelectorAll('[data-hold]').forEach(btn => {
    btn.addEventListener('click', () => {
      $('bt-hold').value = btn.dataset.hold;
      $('bt-hold').dispatchEvent(new Event('change'));
    });
  });

  // 方向分段
  $('bt-direction').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dir]');
    if (!btn) return;
    state.params.direction = btn.dataset.dir;
    ctx.container.querySelectorAll('#bt-direction [data-dir]').forEach(b => {
      const active = b.dataset.dir === state.params.direction;
      b.className = `px-3 py-1 text-xs rounded-md transition-colors ${active ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`;
    });
  });

  // 信号类型勾选
  ctx.container.querySelectorAll('[data-type]').forEach(cb => {
    cb.addEventListener('change', () => {
      const types = [...ctx.container.querySelectorAll('[data-type]:checked')].map(x => x.dataset.type);
      state.params.types = types;
    });
  });

  // 分组全选/清空
  ctx.container.querySelectorAll('[data-toggle-group]').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.toggleGroup;
      const boxes = [...ctx.container.querySelectorAll(`[data-group="${dir}"] [data-type]`)];
      const allOn = boxes.every(b => b.checked);
      boxes.forEach(b => { b.checked = !allOn; });
      const types = [...ctx.container.querySelectorAll('[data-type]:checked')].map(x => x.dataset.type);
      state.params.types = types;
      toast(allOn ? `已清空${dir === 'bullish' ? '看多' : '看空'}信号组` : `已全选${dir === 'bullish' ? '看多' : '看空'}信号组`, 'info', 1600);
    });
  });

  // 自选快捷
  $('bt-watch-quick').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick-code]');
    if (!btn) return;
    $('bt-code').value = btn.dataset.quickCode;
    toast(`已切换为 ${btn.textContent}，点击「运行回验」查看`, 'info', 1800);
  });

  // 图表自适应
  state._resizeHandler = () => state.chart && state.chart.resize();
  window.addEventListener('resize', state._resizeHandler);
}

/** 回验主流程 */
async function runBacktestFlow(ctx, state) {
  const $ = (id) => ctx.container.querySelector('#' + id);
  const resultEl = $('bt-result');

  if (state.running) { toast('回验进行中', 'info'); return; }

  // 收集参数
  const code = $('bt-code').value.trim();
  if (!/^\d{6}$/.test(code)) { toast('请输入6位数字股票代码', 'warn'); return; }
  const hold = Math.max(HOLD_MIN, Math.min(HOLD_MAX, Math.floor(Number($('bt-hold').value) || 5)));

  state.params.code = code;
  state.params.startDate = $('bt-start').value;
  state.params.endDate = $('bt-end').value;
  state.params.holdDays = hold;
  const types = [...ctx.container.querySelectorAll('[data-type]:checked')].map(x => x.dataset.type);
  if (!types.length) { toast('请至少勾选一种信号类型', 'warn'); return; }
  state.params.types = types;

  state.running = true;
  $('bt-run').disabled = true;
  $('bt-run').innerHTML = `<i class="ri-loader-4-line pulse-soft"></i>回验中…`;

  // 图表先清理
  if (state.chart) { state.chart.dispose(); state.chart = null; }
  resultEl.innerHTML = loadingHTML(`正在拉取 ${code} 日K线并统计信号表现…`, '200px');

  try {
    // 拉取较长历史（回验需要足够样本；AxData 按实际可用返回）
    const rows = await request(APIS.klineDaily, { code, adjust: 'qfq' });
    const klines = normalizeKlines(rows);

    const res = runBacktest(klines, {
      types,
      direction: state.params.direction,
      startDate: state.params.startDate,
      endDate: state.params.endDate,
      holdDays: hold,
    });

    state.result = res;
    renderResult(ctx, state);
  } catch (err) {
    state.result = null;
    const apiName = err.api || APIS.klineDaily;
    resultEl.innerHTML = errorHTML(
      `K线数据拉取失败（接口 ${esc(apiName)}）`,
      esc(err.message || String(err)),
      'data-action="retry-bt"'
    );
    resultEl.querySelector('[data-action="retry-bt"]')?.addEventListener('click', () => runBacktestFlow(ctx, state));
  } finally {
    state.running = false;
    $('bt-run').disabled = false;
    $('bt-run').innerHTML = `<i class="ri-play-line"></i>运行回验`;
  }
}

/** 结果区渲染总控 */
function renderResult(ctx, state) {
  const resultEl = ctx.container.querySelector('#bt-result');
  const res = state.result;
  if (!res) return;

  // 无数据（需求 7.3：明确提示，不输出误导性统计）
  if (!res.ok) {
    resultEl.innerHTML = errorHTML('无法回验：无K线数据', esc(res.reason || ''), 'data-action="retry-bt2"');
    resultEl.querySelector('[data-action="retry-bt2"]')?.addEventListener('click', () => runBacktestFlow(ctx, state));
    return;
  }

  // 区间内无任何匹配触发，或触发全部落在尾部未到期
  if (!res.trades.length) {
    const noMatch = res.matchedCount === 0;
    resultEl.innerHTML = `
    <div class="card p-6 text-center">
      <i class="${noMatch ? 'ri-inbox-line' : 'ri-time-line'} text-3xl text-slate-500"></i>
      <p class="mt-2 text-sm text-slate-400 font-medium">${noMatch ? '区间内没有符合条件的信号触发' : `区间内 ${res.matchedCount} 次触发均距数据末端不足 ${res.holdDays} 个交易日，无法计入统计`}</p>
      <p class="mt-1.5 text-xs text-slate-600 leading-relaxed">
        当前数据范围 <span class="tabular text-slate-400">${esc(res.dataRange[0])} ~ ${esc(res.dataRange[1])}</span>（共 ${res.klineCount} 根K线）。<br>
        可尝试：${noMatch ? '放宽时间区间、切换信号类型或方向、更换股票代码' : '减小持有天数 N，或等待更多交易日数据'}。
      </p>
      ${res.insufficiencies.length ? `<p class="mt-2 text-xs text-amber-400/80"><i class="ri-alert-line"></i> 部分指标数据不足已降级：${res.insufficiencies.map(esc).join('；')}</p>` : ''}
    </div>`;
    return;
  }

  resultEl.innerHTML = `
  <div class="space-y-4">
    <!-- 统计卡片 -->
    <div class="card p-4">
      ${renderStatsBar(ctx, state)}
    </div>

    <div class="grid grid-cols-1 xl:grid-cols-5 gap-4">
      <!-- 收益分布直方图 -->
      <div class="xl:col-span-3 card p-4 min-w-0">
        <h3 class="font-medium text-slate-200 text-sm mb-1 flex items-center gap-1.5">
          <i class="ri-bar-chart-2-line text-indigo-400"></i>N=${res.holdDays} 日方向化收益分布
        </h3>
        <p class="text-[11px] text-slate-600 mb-2">看多信号按上涨计收益，看空信号按下跌计收益（方向一致为正）</p>
        <div id="bt-dist-chart" class="chart-box" style="height:240px"></div>
      </div>

      <!-- 样本说明 + 最佳/最差 -->
      <div class="xl:col-span-2 card p-4 min-w-0 flex flex-col gap-3">
        ${renderSampleNotes(ctx, state)}
      </div>
    </div>

    <!-- 明细表 -->
    <div class="card p-4">
      <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
          <i class="ri-list-ordered text-indigo-400"></i>信号触发明细
          <span class="text-xs text-slate-500 font-normal">· ${res.trades.length} 笔</span>
        </h3>
        <div class="flex items-center gap-2">
          <select id="bt-sort" class="field !w-auto !py-1.5 text-xs">
            <option value="time-desc">时间 降序</option>
            <option value="time-asc">时间 升序</option>
            <option value="ret-desc">收益 降序</option>
            <option value="ret-asc">收益 升序</option>
          </select>
          <a href="#/stock/${esc(state.params.code)}" class="btn btn-ghost !py-1.5 text-xs"><i class="ri-candle-line"></i>在个股分析中查看</a>
        </div>
      </div>
      <div id="bt-trades" class="overflow-x-auto">${renderTradesTable(state)}</div>
    </div>
  </div>`;

  // 绑定排序
  ctx.container.querySelector('#bt-sort').addEventListener('change', (e) => {
    state.sortMode = e.target.value;
    ctx.container.querySelector('#bt-trades').innerHTML = renderTradesTable(state);
  });

  renderDistChart(ctx, state);
}

/** 统计指标条 */
function renderStatsBar(ctx, state) {
  const res = state.result;
  const s = res.stats;

  const cells = [
    { label: '触发次数', value: String(res.matchedCount), sub: `含尾部未到期 ${res.skippedTail} 次`, cls: 'text-slate-100', icon: 'ri-flashlight-line', icls: 'text-amber-400' },
    { label: '有效样本', value: String(s.samples), sub: `胜 ${s.wins} / 平 ${s.even} / 负 ${s.losses}`, cls: 'text-slate-100', icon: 'ri-database-2-line', icls: 'text-indigo-400' },
    { label: '胜率', value: fmtPct(s.winRate), sub: `按方向一致统计`, cls: s.winRate >= 50 ? 'text-rise' : 'text-fall', icon: 'ri-trophy-line', icls: s.winRate >= 50 ? 'text-rise' : 'text-fall' },
    { label: '平均收益', value: fmtPct(s.avgReturn, true), sub: '方向化口径', cls: s.avgReturn > 0 ? 'text-rise' : s.avgReturn < 0 ? 'text-fall' : 'text-slate-300', icon: 'ri-line-chart-line', icls: s.avgReturn > 0 ? 'text-rise' : 'text-fall' },
    { label: '中位收益', value: fmtPct(s.medianReturn, true), sub: '样本中位数', cls: s.medianReturn > 0 ? 'text-rise' : s.medianReturn < 0 ? 'text-fall' : 'text-slate-300', icon: 'ri-scales-3-line', icls: 'text-slate-400' },
    { label: '最大单笔亏损', value: fmtPct(s.maxLoss, true), sub: worstSub(s.worstTrade), cls: 'text-fall', icon: 'ri-arrow-down-double-line', icls: 'text-fall' },
    { label: '最大单笔盈利', value: fmtPct(s.maxGain, true), sub: bestSub(s.bestTrade), cls: 'text-rise', icon: 'ri-arrow-up-double-line', icls: 'text-rise' },
  ];

  return `
  <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2.5">
    ${cells.map(c => `
    <div class="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
      <p class="text-[11px] text-slate-500 flex items-center gap-1"><i class="${c.icon} ${c.icls}"></i>${c.label}</p>
      <p class="text-lg font-bold tabular ${c.cls} mt-0.5">${c.value}</p>
      <p class="text-[10px] text-slate-600 mt-0.5 truncate" title="${esc(c.sub)}">${esc(c.sub)}</p>
    </div>`).join('')}
  </div>
  ${renderWarnBar(state)}`;
}

function worstSub(t) { return t ? `${t.label} · ${t.date}` : ''; }
function bestSub(t) { return t ? `${t.label} · ${t.date}` : ''; }

/** 小样本警示条（需求 7.4） */
function renderWarnBar(state) {
  const res = state.result;
  if (!res.smallSample) return '';
  return `
  <div class="mt-3 rounded-lg border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-300/90 flex items-start gap-1.5">
    <i class="ri-alert-line mt-0.5"></i>
    <span>样本量仅 ${res.trades.length} 笔（少于 ${res.minSampleWarn} 笔），统计指标随机波动大，<b>不足以得出有效结论</b>，请谨慎解读。建议放宽时间区间或信号筛选条件以扩大样本。</span>
  </div>`;
}

/** 样本量说明 + 最佳/最差样本卡（需求 7.4：附样本量说明） */
function renderSampleNotes(ctx, state) {
  const res = state.result;
  const s = res.stats;

  const tradeCard = (title, t, cls, icon) => t ? `
    <div class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <p class="text-[11px] text-slate-500 flex items-center gap-1"><i class="${icon} ${cls}"></i>${title}</p>
      <div class="mt-1.5 flex items-center justify-between gap-2 flex-wrap">
        <span class="badge ${t.direction === 'bullish' ? 'bg-rose-950 text-rose-300 border border-rose-900' : 'bg-emerald-950 text-emerald-300 border border-emerald-900'}">
          <i class="${t.direction === 'bullish' ? 'ri-arrow-up-line' : 'ri-arrow-down-line'}"></i>${esc(t.label)}
        </span>
        <span class="text-sm font-bold tabular ${cls}">${fmtPct(t.ret * 100, true)}</span>
      </div>
      <p class="text-[11px] text-slate-600 mt-1.5 tabular">${esc(t.date)} → ${esc(t.exitDate)} · 入 ${fmtNum(t.entryPrice)} / 出 ${fmtNum(t.exitPrice)}</p>
      <p class="text-[11px] text-slate-500 mt-1 leading-relaxed">${esc(t.reason)}</p>
    </div>` : '';

  return `
  <div>
    <p class="text-xs text-slate-400 leading-relaxed">
      <i class="ri-information-line text-slate-500"></i>
      <b class="text-slate-300">样本量说明：</b>
      区间内匹配触发 <b class="tabular text-slate-200">${res.matchedCount}</b> 次，其中
      <b class="tabular text-slate-200">${res.trades.length}</b> 笔持有满 ${res.holdDays} 个交易日计入统计，
      <b class="tabular text-slate-200">${res.skippedTail}</b> 笔距数据末端不足 ${res.holdDays} 根未计入。
      数据范围 <span class="tabular text-slate-300">${esc(res.dataRange[0])} ~ ${esc(res.dataRange[1])}</span>（${res.klineCount} 根K线）。
    </p>
    ${res.insufficiencies.length ? `
    <p class="mt-2 text-xs text-amber-400/80 leading-relaxed">
      <i class="ri-alert-line"></i> 部分指标数据不足，相关信号已降级或跳过：${res.insufficiencies.map(esc).join('；')}
    </p>` : ''}
    <p class="mt-2 text-[11px] text-slate-600 leading-relaxed">
      统计口径：以信号触发日收盘价为基准，持有 N 个交易日后收盘了结；看空信号按价格下跌计为正收益。历史统计仅供个人研究参考，不构成投资建议。
    </p>
  </div>
  ${tradeCard('最大单笔盈利样本', s.bestTrade, 'text-rise', 'ri-arrow-up-double-line')}
  ${tradeCard('最大单笔亏损样本', s.worstTrade, 'text-fall', 'ri-arrow-down-double-line')}`;
}

/** 明细表 */
function renderTradesTable(state) {
  const res = state.result;
  const trades = [...res.trades];

  const sorters = {
    'time-desc': (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.index - a.index),
    'time-asc': (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.index - b.index),
    'ret-desc': (a, b) => b.ret - a.ret,
    'ret-asc': (a, b) => a.ret - b.ret,
  };
  trades.sort(sorters[state.sortMode] || sorters['time-desc']);

  return `
  <table class="w-full text-xs min-w-[860px]">
    <thead>
      <tr class="text-slate-500 text-left border-b border-slate-800">
        <th class="py-2 pr-3 font-normal">触发日期</th>
        <th class="py-2 pr-3 font-normal">信号</th>
        <th class="py-2 pr-3 font-normal text-right">触发价</th>
        <th class="py-2 pr-3 font-normal text-right">${res.holdDays}日后</th>
        <th class="py-2 pr-3 font-normal">了结日期</th>
        <th class="py-2 pr-3 font-normal text-right">实际涨跌</th>
        <th class="py-2 pr-3 font-normal text-right">方向化收益</th>
        <th class="py-2 pr-3 font-normal">触发理由</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-slate-800/60">
      ${trades.map(t => `
      <tr class="row-hover">
        <td class="py-2 pr-3 tabular text-slate-300">${esc(t.date)}</td>
        <td class="py-2 pr-3">
          <span class="badge ${t.direction === 'bullish' ? 'bg-rose-950 text-rose-300 border border-rose-900' : 'bg-emerald-950 text-emerald-300 border border-emerald-900'}">
            <i class="${t.direction === 'bullish' ? 'ri-arrow-up-line' : 'ri-arrow-down-line'}"></i>${esc(t.label)}
          </span>
        </td>
        <td class="py-2 pr-3 text-right tabular text-slate-300">${fmtNum(t.entryPrice)}</td>
        <td class="py-2 pr-3 text-right tabular text-slate-300">${fmtNum(t.exitPrice)}</td>
        <td class="py-2 pr-3 tabular text-slate-400">${esc(t.exitDate)}</td>
        <td class="py-2 pr-3 text-right tabular ${t.rawRet > 0 ? 'text-rise' : t.rawRet < 0 ? 'text-fall' : 'text-slate-400'}">${fmtPct(t.rawRet * 100, true)}</td>
        <td class="py-2 pr-3 text-right tabular font-bold ${t.ret > 0 ? 'text-rise' : t.ret < 0 ? 'text-fall' : 'text-slate-400'}">${fmtPct(t.ret * 100, true)}</td>
        <td class="py-2 pr-3 text-slate-500 max-w-[320px] truncate" title="${esc(t.reason)}">${esc(t.reason)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

/** 收益分布直方图（ECharts） */
function renderDistChart(ctx, state) {
  const el = ctx.container.querySelector('#bt-dist-chart');
  if (!el) return;

  const res = state.result;
  const dist = bucketDistribution(res.trades);
  const chart = echarts.init(el);
  state.chart = chart;

  chart.setOption({
    animation: true,
    backgroundColor: 'transparent',
    grid: { left: 40, right: 12, top: 24, bottom: 28 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(15,23,42,.95)',
      borderColor: '#334155',
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      formatter: (params) => {
        const p = Array.isArray(params) ? params[0] : params;
        const b = dist[p.dataIndex];
        return `<div>${b.label}：${b.count} 笔（${b.pct.toFixed(1)}%）</div>`;
      }
    },
    xAxis: {
      type: 'category',
      data: dist.map(b => b.label),
      axisLine: { lineStyle: { color: '#334155' } },
      axisLabel: { color: '#64748b', fontSize: 10, interval: 0, rotate: 32 },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: '#64748b', fontSize: 10 },
      splitLine: { lineStyle: { color: '#1e293b' } }
    },
    series: [{
      name: '样本数',
      type: 'bar',
      barWidth: '72%',
      data: dist.map((b, i) => ({
        value: b.count,
        itemStyle: {
          color: b.count === 0 ? '#1e293b' : bucketColor(i),
          borderRadius: [3, 3, 0, 0]
        }
      })),
      label: {
        show: true,
        position: 'top',
        color: '#94a3b8',
        fontSize: 10,
        formatter: (p) => (p.value > 0 ? p.value : '')
      }
    }]
  });
}
