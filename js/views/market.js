/**
 * views/market.js — 市场情绪视图
 * - 连板天梯（按连板数分组展示）
 * - 题材强度榜（强度排序 + 热力条）
 * 数据不可用时优雅降级占位（需求 5.2、5.3）。
 */

import { request, APIS } from '../api.js';
import { normalizeLadder, normalizeTheme } from '../normalize.js';
import { addWatch, getWatchlist } from '../store.js';
import { toast, loadingHTML, esc, fmtNum, pctSpan } from '../ui.js';

export function registerMarketView(registerRoute) {
  registerRoute('/market', async (ctx) => {
    const { container } = ctx;

    container.innerHTML = `
    <div class="space-y-4">
      <div class="flex items-center gap-2">
        <i class="ri-fire-line text-xl text-orange-400"></i>
        <h2 class="text-lg font-bold text-slate-100">市场情绪</h2>
        <span class="text-xs text-slate-500">连板天梯与题材强度（短线情绪参考）</span>
      </div>
      <div id="market-content" class="space-y-4">${loadingHTML('正在拉取市场情绪数据…')}</div>
    </div>`;

    const root = container.querySelector('#market-content');

    // 并行拉取两个市场级数据源，各自独立降级
    const [ladderRes, themeRes] = await Promise.allSettled([
      request(APIS.limitLadder, { scope: 'all' }),
      request(APIS.themeStrength, { scope: 'all' })
    ]);

    renderLadder(root, ladderRes);
    renderTheme(root, themeRes);
  });
}

/** 连板天梯 */
function renderLadder(root, res) {
  const wrap = document.createElement('div');
  wrap.className = 'card p-4';
  wrap.innerHTML = `
    <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
      <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
        <i class="ri-ladder-line text-orange-400"></i>连板天梯
      </h3>
      <span class="text-xs text-slate-500">高度反映市场情绪空间，断板代表退潮</span>
    </div>
    <div id="ladder-body"></div>`;
  root.appendChild(wrap);

  const body = wrap.querySelector('#ladder-body');

  if (res.status !== 'fulfilled' || !Array.isArray(res.value) || !res.value.length) {
    body.innerHTML = degradeHTML('连板天梯', res, APIS.limitLadder);
    return;
  }

  const rows = res.value.map(normalizeLadder).filter(x => x.code && x.seq != null);
  // 按连板数分组（降序）
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.seq)) groups.set(r.seq, []);
    groups.get(r.seq).push(r);
  }
  const seqs = [...groups.keys()].sort((a, b) => b - a);
  if (!seqs.length) {
    body.innerHTML = degradeHTML('连板天梯', null, APIS.limitLadder);
    return;
  }

  const maxSeq = seqs[0];
  body.innerHTML = `
  <div class="space-y-3">
    ${seqs.map(seq => {
      const list = groups.get(seq);
      const hot = seq >= maxSeq - 1 && maxSeq >= 3; // 高位板高亮
      return `
      <div class="flex items-start gap-3">
        <div class="shrink-0 w-16 text-center">
          <div class="text-2xl font-bold tabular ${hot ? 'text-orange-400' : 'text-slate-300'}">${seq}</div>
          <div class="text-[10px] text-slate-500">连板</div>
        </div>
        <div class="flex-1 flex flex-wrap gap-2 pt-1">
          ${list.map(s => {
            const watched = getWatchlist().some(x => x.code === s.code);
            return `<div class="group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors cursor-pointer ${hot ? 'border-orange-800/70 bg-orange-950/30 hover:border-orange-600' : 'border-slate-800 bg-slate-900/60 hover:border-slate-600'}" data-code="${esc(s.code)}" data-name="${esc(s.name)}" title="点击查看个股分析，长按加入自选">
              <a href="#/stock/${esc(s.code)}" class="font-medium text-slate-200 hover:text-indigo-300">${esc(s.name)}</a>
              <span class="text-slate-500 font-mono text-[10px]">${esc(s.code)}</span>
              ${s.theme ? `<span class="badge bg-indigo-950/60 text-indigo-300 border border-indigo-900/60 !text-[10px]">${esc(s.theme)}</span>` : ''}
              ${s.pct != null ? pctSpan(s.pct, { muted: false }) : ''}
              <button data-watch="${esc(s.code)}" data-wname="${esc(s.name)}" class="text-slate-600 hover:text-amber-400 transition-colors" title="加入自选">
                <i class="${watched ? 'ri-star-fill text-amber-400' : 'ri-star-line'}"></i>
              </button>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }).join('')}
  </div>`;

  // 星标加自选（事件委托）
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-watch]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const code = btn.dataset.watch;
    if (addWatch(code, btn.dataset.wname || code)) {
      toast(`已加入自选：${btn.dataset.wname || code}`, 'success');
      btn.innerHTML = '<i class="ri-star-fill text-amber-400"></i>';
    } else {
      toast('该股票已在自选中', 'info');
    }
  });
}

/** 题材强度榜 */
function renderTheme(root, res) {
  const wrap = document.createElement('div');
  wrap.className = 'card p-4';
  wrap.innerHTML = `
    <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
      <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
        <i class="ri-bar-chart-grouped-line text-amber-400"></i>题材强度榜
      </h3>
      <span class="text-xs text-slate-500">按 AxData 题材强度分排序，综合涨停家数与连板高度</span>
    </div>
    <div id="theme-body"></div>`;
  root.appendChild(wrap);

  const body = wrap.querySelector('#theme-body');

  if (res.status !== 'fulfilled' || !Array.isArray(res.value) || !res.value.length) {
    body.innerHTML = degradeHTML('题材强度', res, APIS.themeStrength);
    return;
  }

  const rows = res.value.map(normalizeTheme).filter(x => x.theme);
  rows.sort((a, b) => (b.strength || 0) - (a.strength || 0));
  if (!rows.length) {
    body.innerHTML = degradeHTML('题材强度', null, APIS.themeStrength);
    return;
  }

  const maxStrength = Math.max(...rows.map(r => r.strength || 0), 1);
  body.innerHTML = `
  <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
    ${rows.map((r, i) => {
      const w = Math.max(3, (r.strength || 0) / maxStrength * 100);
      const hot = i < 3;
      return `
      <div class="rounded-lg border p-3 ${hot ? 'border-amber-800/60 bg-amber-950/20' : 'border-slate-800 bg-slate-900/50'} hover:border-slate-600 transition-colors">
        <div class="flex items-center justify-between gap-2 mb-1.5">
          <div class="flex items-center gap-1.5 min-w-0">
            ${hot ? `<span class="badge bg-amber-900/70 text-amber-300 !text-[10px]">TOP${i + 1}</span>` : ''}
            <span class="font-medium text-slate-200 truncate">${esc(r.theme)}</span>
          </div>
          ${r.pct != null ? pctSpan(r.pct) : ''}
        </div>
        <div class="h-1.5 rounded-full bg-slate-800 overflow-hidden mb-2">
          <div class="h-full rounded-full ${hot ? 'bg-gradient-to-r from-amber-500 to-orange-500' : 'bg-indigo-500'}" style="width:${w}%"></div>
        </div>
        <div class="flex items-center justify-between text-[11px] text-slate-500">
          <span class="tabular">强度 ${fmtNum(r.strength, 1)}</span>
          <span class="tabular">涨停 <span class="text-rise">${r.limitCount ?? 0}</span> 家 · 连板 ${r.totalCount ?? '--'} 家</span>
          ${r.leader ? `<a href="#/stock/${esc(r.leaderCode)}" class="text-indigo-400 hover:text-indigo-300 truncate max-w-[30%]" title="龙头：${esc(r.leader)}">龙:${esc(r.leader)}</a>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

/** 降级占位 */
function degradeHTML(title, res, apiName) {
  const reason = res && res.status === 'rejected'
    ? esc(String(res.reason?.message || res.reason))
    : '对应 Provider 未启用或当日无数据';
  return `
  <div class="rounded-lg border border-dashed border-slate-700 bg-slate-900/40 p-6 text-center">
    <i class="ri-plug-line text-2xl text-slate-600"></i>
    <p class="text-sm text-slate-400 mt-2">${title}数据不可用</p>
    <p class="text-xs text-slate-600 mt-1 max-w-md mx-auto leading-relaxed">
      该视图依赖 AxData 的 <code class="text-indigo-300">${esc(apiName)}</code> 接口（${reason}）。
      请在 AxData 中启用对应采集任务，或到 <a href="#/config" class="text-indigo-400 underline">配置页</a> 测试连接。
    </p>
  </div>`;
}
