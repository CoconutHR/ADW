/**
 * views/market.js — 市场情绪视图
 * - 连板天梯（按连板数分组展示）
 * - 题材强度榜（强度排序 + 热力条）
 *
 * 渲染约定：两个数据源各自一张卡片、各自维护自己的加载态，
 * 谁先返回谁先渲染，任一失败只降级自己那张卡片。
 * 早期实现共用一个 loading 占位符且只用 appendChild 追加，
 * 占位符永远不会被移除，页面看起来就一直卡在"正在拉取市场情绪数据…"。
 */

import { request, APIS } from '../api.js';
import { normalizeLadder, normalizeTheme } from '../normalize.js';
import { addWatch, getWatchlist } from '../store.js';
import { toast, esc, fmtNum, pctSpan } from '../ui.js';

/** 市场级接口耗时明显高于个股（实测 5 秒上下），给足超时避免 10s 默认值误判为失败 */
const MARKET_TIMEOUT_MS = 30000;

export function registerMarketView(registerRoute) {
  registerRoute('/market', (ctx) => {
    const { container } = ctx;

    container.innerHTML = `
    <div class="space-y-4">
      <div class="flex items-center gap-2">
        <i class="ri-fire-line text-xl text-orange-400"></i>
        <h2 class="text-lg font-bold text-slate-100">市场情绪</h2>
        <span class="text-xs text-slate-500">连板天梯与题材强度（短线情绪参考）</span>
      </div>
      <div id="ladder-card" class="card p-4">${cardSkeleton('连板天梯', '高度反映市场情绪空间，断板代表退潮', 'ri-ladder-line text-orange-400')}</div>
      <div id="theme-card" class="card p-4">${cardSkeleton('题材强度榜', '按 AxData 题材强度分排序，综合涨停家数与连板高度', 'ri-bar-chart-grouped-line text-amber-400')}</div>
    </div>`;

    const ladderCard = container.querySelector('#ladder-card');
    const themeCard = container.querySelector('#theme-card');

    // 并行拉取、独立渲染：任一失败只降级自己那张卡片，不会整页卡住
    loadCard(ladderCard, APIS.limitLadder, '连板天梯', renderLadder);
    loadCard(themeCard, APIS.themeStrength, '题材强度', renderTheme);
  });
}

/** 卡片骨架：标题 + 加载态正文 */
function cardSkeleton(title, subtitle, icon) {
  return `
    <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
      <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
        <i class="${icon}"></i>${title}
      </h3>
      <span class="text-xs text-slate-500">${esc(subtitle)}</span>
    </div>
    <div class="flex flex-col items-center justify-center text-slate-500 gap-2 py-8">
      <i class="ri-loader-4-line text-2xl pulse-soft"></i>
      <p class="text-xs">正在拉取${esc(title)}…（市场级数据通常需要数秒）</p>
    </div>`;
}

/**
 * 拉取并渲染单张卡片，失败则原地降级为可重试的占位。
 * @param {HTMLElement} card 卡片容器
 * @param {string} api 接口名
 * @param {string} title 降级文案用的标题
 * @param {Function} render (card, rows) => void
 */
async function loadCard(card, api, title, render) {
  try {
    const rows = await request(api, { scope: 'all' }, null, { timeoutMs: MARKET_TIMEOUT_MS });
    render(card, rows);
  } catch (err) {
    renderDegrade(card, title, err, api);
  }
}

/** 连板天梯 */
function renderLadder(card, rows) {
  if (!Array.isArray(rows) || !rows.length) {
    renderDegrade(card, '连板天梯', null, APIS.limitLadder);
    return;
  }

  const list = rows.map(normalizeLadder).filter(x => x.code && x.seq != null);
  // 按连板数分组（降序）
  const groups = new Map();
  for (const r of list) {
    if (!groups.has(r.seq)) groups.set(r.seq, []);
    groups.get(r.seq).push(r);
  }
  const seqs = [...groups.keys()].sort((a, b) => b - a);
  if (!seqs.length) {
    renderDegrade(card, '连板天梯', null, APIS.limitLadder);
    return;
  }

  const maxSeq = seqs[0];
  card.innerHTML = `
    <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
      <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
        <i class="ri-ladder-line text-orange-400"></i>连板天梯
      </h3>
      <span class="text-xs text-slate-500">高度反映市场情绪空间，断板代表退潮 · 共 ${list.length} 只</span>
    </div>
    <div class="space-y-3">
      ${seqs.map(seq => {
        const g = groups.get(seq);
        const hot = seq >= maxSeq - 1 && maxSeq >= 3; // 高位板高亮
        return `
        <div class="flex items-start gap-3">
          <div class="shrink-0 w-16 text-center">
            <div class="text-2xl font-bold tabular ${hot ? 'text-orange-400' : 'text-slate-300'}">${seq}</div>
            <div class="text-[10px] text-slate-500">连板</div>
          </div>
          <div class="flex-1 flex flex-wrap gap-2 pt-1">
            ${g.map(s => {
              const watched = getWatchlist().some(x => x.code === s.code);
              return `<div class="group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${hot ? 'border-orange-800/70 bg-orange-950/30 hover:border-orange-600' : 'border-slate-800 bg-slate-900/60 hover:border-slate-600'}">
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
  card.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-watch]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (addWatch(btn.dataset.watch, btn.dataset.wname || btn.dataset.watch)) {
      toast(`已加入自选：${btn.dataset.wname || btn.dataset.watch}`, 'success');
      btn.innerHTML = '<i class="ri-star-fill text-amber-400"></i>';
    } else {
      toast('该股票已在自选中', 'info');
    }
  });
}

/** 题材强度榜 */
function renderTheme(card, rows) {
  if (!Array.isArray(rows) || !rows.length) {
    renderDegrade(card, '题材强度', null, APIS.themeStrength);
    return;
  }

  const list = rows.map(normalizeTheme).filter(x => x.theme);
  list.sort((a, b) => (b.strength || 0) - (a.strength || 0));
  if (!list.length) {
    renderDegrade(card, '题材强度', null, APIS.themeStrength);
    return;
  }

  const maxStrength = Math.max(...list.map(r => r.strength || 0), 1);
  card.innerHTML = `
    <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
      <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
        <i class="ri-bar-chart-grouped-line text-amber-400"></i>题材强度榜
      </h3>
      <span class="text-xs text-slate-500">按 AxData 题材强度分排序，综合涨停家数与连板高度 · 共 ${list.length} 个题材</span>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5">
      ${list.map((r, i) => {
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

/** 降级占位（原地替换整张卡片，带重试） */
function renderDegrade(card, title, err, apiName) {
  const reason = err ? esc(String(err.message || err)) : '对应 Provider 未启用或当日无数据';
  const api = String(apiName || '');
  card.innerHTML = `
  <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
    <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
      <i class="ri-plug-line text-slate-500"></i>${esc(title)}
    </h3>
  </div>
  <div class="rounded-lg border border-dashed border-slate-700 bg-slate-900/40 p-6 text-center">
    <i class="ri-plug-line text-2xl text-slate-600"></i>
    <p class="text-sm text-slate-400 mt-2">${esc(title)}数据不可用</p>
    <p class="text-xs text-slate-600 mt-1 max-w-md mx-auto leading-relaxed">
      该视图依赖 AxData 的 <code class="text-indigo-300">${esc(api)}</code> 接口（${reason}）。
      请在 AxData 中启用对应采集任务，或到 <a href="#/config" class="text-indigo-400 underline">配置页</a> 测试连接。
    </p>
    <button data-retry class="btn btn-ghost mt-4 !py-1.5 text-xs"><i class="ri-refresh-line"></i>重试</button>
  </div>`;

  card.querySelector('[data-retry]')?.addEventListener('click', () => {
    const render = api === APIS.limitLadder ? renderLadder : renderTheme;
    card.innerHTML = cardSkeleton(title === '题材强度' ? '题材强度榜' : title, '重新拉取中…',
      api === APIS.limitLadder ? 'ri-ladder-line text-orange-400' : 'ri-bar-chart-grouped-line text-amber-400');
    loadCard(card, api, title, render);
  });
}
