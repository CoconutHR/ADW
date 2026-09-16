/**
 * views/scan.js — 自选股管理与批量扫描页
 * - 自选股增删（本地持久化、即时刷新）
 * - 批量扫描：受限并发逐只拉取 → 指标计算 → 信号识别 → 五维评分
 * - 进度展示、中途取消
 * - 结果表：按综合评分/信号方向/涨跌幅排序筛选，点击行跳转个股详情
 */

import { request, APIS, klineAdjustParams } from '../api.js';
import { normalizeKlines, normalizeSnapshot } from '../normalize.js';
import { computeAll } from '../indicators.js';
import { detectSignals, recentSignals, summarizeSignals } from '../signal.js';
import { computeScore } from '../scoring.js';
import { createScheduler } from '../scheduler.js';
import { getWatchlist, addWatch, removeWatch, saveWatchlist } from '../store.js';
import { ensureNames, getName, searchStocks, resolveCode, stockLabel, stockLabelHTML, backfillWatchNames, namesReady } from '../names.js';
import { toast, loadingHTML, emptyHTML, esc, fmtNum, pctSpan, signalBadge } from '../ui.js';

const CONCLUSION_CLS = {
  bullish: 'bg-rose-950 text-rose-300 border border-rose-900',
  neutral: 'bg-slate-800 text-slate-300 border border-slate-700',
  bearish: 'bg-emerald-950 text-emerald-300 border border-emerald-900'
};
const CONCLUSION_LABEL = { bullish: '偏多', neutral: '中性', bearish: '偏空' };

let scanState = { running: false, scheduler: null };

export function registerScanView(registerRoute) {
  registerRoute('/scan', async (ctx) => {
    const { container } = ctx;

    container.innerHTML = `
    <div class="space-y-4">
      <!-- 自选股管理 -->
      <div class="card p-4">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
            <i class="ri-star-line text-amber-400"></i>自选股
            <span id="watch-count" class="text-xs text-slate-500 font-normal"></span>
          </h3>
          <div class="flex items-center gap-2">
            <div class="relative">
              <input id="watch-input" class="field w-56 pl-8 !py-1.5 text-xs" placeholder="代码或名称，如 600519 / 茅台" autocomplete="off" spellcheck="false">
              <i class="ri-search-line absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
              <div id="watch-suggest" class="hidden absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl"></div>
            </div>
            <button id="watch-add" class="btn btn-ghost !py-1.5 text-xs">添加</button>
          </div>
        </div>
        <div id="watch-list" class="flex flex-wrap gap-2"></div>
      </div>

      <!-- 扫描控制 -->
      <div class="card p-4">
        <div class="flex items-center justify-between flex-wrap gap-3">
          <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
            <i class="ri-radar-line text-indigo-400"></i>批量信号扫描
          </h3>
          <div class="flex items-center gap-2">
            <button id="scan-start" class="btn btn-primary text-xs"><i class="ri-play-line"></i>开始扫描</button>
            <button id="scan-cancel" class="btn btn-danger text-xs hidden"><i class="ri-stop-line"></i>取消</button>
          </div>
        </div>
        <div class="mt-3">
          <div class="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div id="scan-progress-bar" class="h-full w-0 rounded-full bg-indigo-500 transition-all duration-300"></div>
          </div>
          <div class="flex items-center justify-between mt-1.5">
            <p id="scan-progress-text" class="text-xs text-slate-500">扫描以受限并发逐只拉取日K线（120根）并计算信号与评分，避免打爆 AxData 服务</p>
          </div>
        </div>
      </div>

      <!-- 结果表 -->
      <div class="card p-4">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
            <i class="ri-list-check-2 text-indigo-400"></i>扫描结果
            <span id="result-count" class="text-xs text-slate-500 font-normal"></span>
          </h3>
          <div class="flex items-center gap-1.5">
            <select id="sort-by" class="field !w-auto !py-1.5 text-xs">
              <option value="score">按综合评分</option>
              <option value="pct">按涨跌幅</option>
              <option value="bull">按看多信号数</option>
              <option value="bear">按看空信号数</option>
            </select>
            <select id="filter-dir" class="field !w-auto !py-1.5 text-xs">
              <option value="all">全部方向</option>
              <option value="bullish">仅偏多</option>
              <option value="neutral">仅中性</option>
              <option value="bearish">仅偏空</option>
            </select>
          </div>
        </div>
        <div id="scan-result" class="overflow-x-auto">${emptyHTML('尚未扫描，添加自选股后点击"开始扫描"', 'ri-radar-line')}</div>
      </div>
    </div>`;

    renderWatchList(ctx);
    bindEvents(ctx);

    // 名称目录就绪后补全已有自选（早期按代码添加时名称=代码）并重绘
    ensureNames().then(() => {
      const list = getWatchlist();
      if (backfillWatchNames(list)) saveWatchlist(list);
      renderWatchList(ctx);
    });
  });
}

/** 自选股标签列表 */
function renderWatchList(ctx) {
  const listEl = ctx.container.querySelector('#watch-list');
  const countEl = ctx.container.querySelector('#watch-count');
  const list = getWatchlist();

  countEl.textContent = `· ${list.length} 只`;

  if (!list.length) {
    listEl.innerHTML = `<p class="text-xs text-slate-500">暂无自选股，可输入代码或名称（如 <code class="text-indigo-300">600519</code>、<code class="text-indigo-300">茅台</code>）后点添加</p>`;
    return;
  }

  listEl.innerHTML = list.map(w => `
    <div class="group flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 pl-2.5 pr-1.5 py-1.5 text-xs hover:border-slate-600 transition-colors">
      ${stockLabelHTML(w.code, w.name, { nameCls: 'text-slate-200' })}
      <button data-remove="${esc(w.code)}" class="text-slate-600 hover:text-rose-400 transition-colors" title="移除">
        <i class="ri-close-line"></i>
      </button>
    </div>`).join('');
}

/** 事件绑定 */
function bindEvents(ctx) {
  const $ = (id) => ctx.container.querySelector('#' + id);

  // ---- 添加自选：代码 / 名称 搜索 + 候选下拉 ----
  const box = $('watch-suggest');
  let timer = null;
  let items = [];
  let active = -1;

  const hideSuggest = () => { box.classList.add('hidden'); box.innerHTML = ''; items = []; active = -1; };

  const renderSuggest = (list) => {
    items = list;
    active = list.length ? 0 : -1;
    if (!list.length) { hideSuggest(); return; }
    box.innerHTML = list.map((s, i) => `
      <div data-idx="${i}" class="px-2.5 py-1.5 text-xs cursor-pointer flex items-center justify-between gap-2 ${i === 0 ? 'bg-slate-800' : 'hover:bg-slate-800'}">
        <span class="text-slate-200 truncate">${esc(s.name)}</span>
        <span class="text-slate-500 font-mono text-[10px] shrink-0">${esc(s.code)}</span>
      </div>`).join('');
    box.classList.remove('hidden');
  };

  const updateSuggest = async () => {
    const q = $('watch-input').value.trim();
    if (!q) { hideSuggest(); return; }
    await ensureNames();
    const list = searchStocks(q, 10);
    // 6 位代码即使未被目录收录（新股/退市）也允许直接添加
    if (/^\d{6}$/.test(q) && !list.some(x => x.code === q)) {
      list.unshift({ code: q, name: getName(q) || '（目录未收录）' });
    }
    if (!list.length) {
      box.innerHTML = `<div class="px-2.5 py-2 text-xs text-slate-500">未找到匹配项${namesReady() ? '' : '（名称目录加载中，可稍后重试）'}</div>`;
      box.classList.remove('hidden');
      items = []; active = -1;
      return;
    }
    renderSuggest(list);
  };

  const addByCode = (code, name) => {
    const nm = (name && name !== '（目录未收录）') ? name : (getName(code) || code);
    if (addWatch(code, nm)) {
      toast(`已添加自选：${stockLabel(code, nm)}`, 'success');
      $('watch-input').value = '';
      hideSuggest();
      renderWatchList(ctx);
    } else {
      toast('该股票已在自选中', 'info');
    }
  };

  const doAdd = async () => {
    const raw = $('watch-input').value.trim();
    if (!raw) return;
    // 兼容手工格式：600519 / 600519,贵州茅台 / 600519 贵州茅台
    const m = raw.match(/^(\d{6})\s*[,，\s]?\s*(.*)$/);
    if (m) { addByCode(m[1], m[2] ? m[2].trim() : getName(m[1])); return; }
    // 名称搜索：唯一命中直接加入，多个命中取首条
    await ensureNames();
    const code = resolveCode(raw);
    if (!code) { toast(`未找到「${raw}」，可改用 6 位代码添加`, 'warn'); return; }
    addByCode(code, getName(code));
  };

  $('watch-add').addEventListener('click', doAdd);
  $('watch-input').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(updateSuggest, 120);
  });
  $('watch-input').addEventListener('focus', updateSuggest);
  $('watch-input').addEventListener('blur', () => setTimeout(hideSuggest, 160));
  $('watch-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideSuggest(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      active = e.key === 'ArrowDown'
        ? Math.min(items.length - 1, active + 1)
        : Math.max(0, active - 1);
      box.querySelectorAll('[data-idx]').forEach(el => {
        el.className = Number(el.dataset.idx) === active
          ? 'px-2.5 py-1.5 text-xs cursor-pointer flex items-center justify-between gap-2 bg-slate-800'
          : 'px-2.5 py-1.5 text-xs cursor-pointer flex items-center justify-between gap-2 hover:bg-slate-800';
      });
      return;
    }
    if (e.key === 'Enter') {
      if (items.length && active >= 0) addByCode(items[active].code, items[active].name);
      else doAdd();
    }
  });
  // mousedown 早于 blur，保证点击候选项不会被隐藏抢先
  box.addEventListener('mousedown', (e) => {
    const row = e.target.closest('[data-idx]');
    if (!row) return;
    e.preventDefault();
    const s = items[Number(row.dataset.idx)];
    if (s) addByCode(s.code, s.name);
  });

  // 移除自选（事件委托）
  ctx.container.querySelector('#watch-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    removeWatch(btn.dataset.remove);
    renderWatchList(ctx);
    toast('已移除自选', 'info');
  });

  // 开始扫描
  $('scan-start').addEventListener('click', () => startScan(ctx));

  // 取消扫描
  $('scan-cancel').addEventListener('click', () => {
    if (scanState.scheduler) scanState.scheduler.cancel();
    toast('扫描已取消（已完成结果保留）', 'warn');
  });

  // 排序与筛选
  $('sort-by').addEventListener('change', () => renderResultTable(ctx));
  $('filter-dir').addEventListener('change', () => renderResultTable(ctx));
}

/** 批量扫描主流程 */
async function startScan(ctx) {
  const $ = (id) => ctx.container.querySelector('#' + id);
  const watch = getWatchlist();

  if (!watch.length) { toast('自选股为空，请先添加', 'warn'); return; }
  if (scanState.running) { toast('扫描进行中', 'info'); return; }

  scanState.running = true;
  scanState.results = [];
  $('scan-start').disabled = true;
  $('scan-cancel').classList.remove('hidden');
  $('scan-progress-bar').style.width = '0%';
  $('result-count').textContent = '';

  const bar = $('scan-progress-bar');
  const text = $('scan-progress-text');

  const scheduler = createScheduler(async (item) => {
    // 每只股票的完整分析管线（失败项由调度器标记 __error）
    const rows = await request(APIS.klineDaily, { code: item.code, ...klineAdjustParams() });
    const klines = normalizeKlines(rows).slice(-120);
    if (!klines.length) throw new Error('无K线数据');

    const indicators = computeAll(klines);
    const det = detectSignals(klines, { indicators });

    // 实时快照（可选，失败不影响扫描）
    let snapshot = null;
    try {
      const s = await request(APIS.realtimeSnapshot, { code: item.code });
      if (Array.isArray(s) && s.length) snapshot = normalizeSnapshot(s[0]);
    } catch { /* ignore */ }

    // 特色指标（可选）
    let feature = null;
    try {
      const f = await request(APIS.spotFeature, { code: item.code });
      if (Array.isArray(f) && f.length) feature = f[0];
    } catch { /* ignore */ }

    const score = computeScore(klines, indicators, { feature });
    const recent = recentSignals(det.signals, klines.length, 10);
    const sum = summarizeSignals(recent);

    const last = klines[klines.length - 1];
    const prev = klines[klines.length - 2] || last;
    const pct = snapshot?.changePct ?? ((last.close - prev.close) / prev.close * 100);

    return {
      code: item.code,
      name: snapshot?.name || (item.name !== item.code ? item.name : '') || getName(item.code) || item.code,
      pct,
      score: score.ok ? score : null,
      conclusion: score.ok ? score.conclusion : null,
      bullCount: sum.bull,
      bearCount: sum.bear,
      latestSignals: recent.slice(-3).reverse(),
      klineCount: klines.length
    };
  }, {
    concurrency: 3,
    onProgress: (done, total) => {
      bar.style.width = `${(done / total) * 100}%`;
      text.textContent = `扫描中 ${done}/${total}（受限并发 3，逐只计算信号与评分）`;
    }
  });

  scanState.scheduler = scheduler;

  scheduler.run(watch).then((results) => {
    scanState.results = results.map((r, i) => {
      if (r && r.__error) {
        return { code: watch[i].code, name: watch[i].name || watch[i].code, error: r.__error };
      }
      return r;
    });
    scanState.running = false;
    scanState.scheduler = null;
    $('scan-start').disabled = false;
    $('scan-cancel').classList.add('hidden');
    const okCnt = scanState.results.filter(x => !x.error).length;
    text.textContent = `扫描完成：成功 ${okCnt} / 失败 ${scanState.results.length - okCnt}`;
    toast(`扫描完成（${okCnt}/${scanState.results.length}）`, 'success');
    renderResultTable(ctx);
  });
}

/** 结果表渲染 */
function renderResultTable(ctx) {
  const $ = (id) => ctx.container.querySelector('#' + id);
  const root = $('scan-result');
  const results = (scanState.results || []).filter(Boolean);
  const sortBy = $('sort-by').value;
  const filterDir = $('filter-dir').value;

  $('result-count').textContent = results.length ? `· ${results.length} 只` : '';

  let rows = results.filter(r => filterDir === 'all' || r.conclusion === filterDir);

  const sorters = {
    score: (a, b) => (b.score?.composite ?? -1) - (a.score?.composite ?? -1),
    pct: (a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity),
    bull: (a, b) => (b.bullCount || 0) - (a.bullCount || 0),
    bear: (a, b) => (b.bearCount || 0) - (a.bearCount || 0)
  };
  rows.sort(sorters[sortBy] || sorters.score);

  if (!rows.length) {
    root.innerHTML = emptyHTML(scanState.running ? '扫描中，暂无符合条件的结果' : '暂无扫描结果', 'ri-radar-line');
    return;
  }

  root.innerHTML = `
  <table class="w-full text-xs min-w-[760px]">
    <thead>
      <tr class="text-slate-500 text-left border-b border-slate-800">
        <th class="py-2 pr-3 font-normal">股票</th>
        <th class="py-2 pr-3 font-normal text-right">涨跌幅</th>
        <th class="py-2 pr-3 font-normal text-right">综合评分</th>
        <th class="py-2 pr-3 font-normal text-center">结论</th>
        <th class="py-2 pr-3 font-normal text-center">信号(10日)</th>
        <th class="py-2 pr-3 font-normal">最新信号</th>
      </tr>
    </thead>
    <tbody class="divide-y divide-slate-800/60">
      ${rows.map(r => {
        if (r.error) {
          return `<tr class="row-hover">
            <td class="py-2.5 pr-3">${stockLabelHTML(r.code, r.name, { nameCls: 'text-slate-300' })}</td>
            <td colspan="5" class="py-2.5 text-rose-400/80 text-[11px]"><i class="ri-error-warning-line"></i> ${esc(r.error.message || '扫描失败')}</td>
          </tr>`;
        }
        const cs = r.conclusion ? CONCLUSION_CLS[r.conclusion] : '';
        return `<tr class="row-hover cursor-pointer" data-goto="${esc(r.code)}">
          <td class="py-2.5 pr-3">
            ${stockLabelHTML(r.code, r.name, { nameCls: 'text-slate-200 font-medium' })}
          </td>
          <td class="py-2.5 pr-3 text-right">${pctSpan(r.pct)}</td>
          <td class="py-2.5 pr-3 text-right tabular font-bold ${r.score?.composite >= 60 ? 'text-rise' : r.score?.composite <= 40 ? 'text-fall' : 'text-slate-300'}">${r.score ? fmtNum(r.score.composite, 1) : '--'}</td>
          <td class="py-2.5 pr-3 text-center">${r.conclusion ? `<span class="badge ${cs}">${CONCLUSION_LABEL[r.conclusion]}</span>` : '--'}</td>
          <td class="py-2.5 pr-3 text-center tabular"><span class="text-rise">↑${r.bullCount || 0}</span> <span class="text-fall">↓${r.bearCount || 0}</span></td>
          <td class="py-2.5 pr-3">
            <div class="flex items-center gap-1 flex-wrap">
              ${(r.latestSignals || []).map(s => signalBadge(s)).join('') || '<span class="text-slate-600">近10日无信号</span>'}
            </div>
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;

  // 行点击跳转（信号徽章区域除外，因其本身是 span）
  root.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-goto]');
    if (tr) location.hash = `#/stock/${tr.dataset.goto}`;
  }, { once: false });
}
