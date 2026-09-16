/**
 * components/score-panel.js — 五维评分与框架性建议面板
 * 展示：综合评分环形图、三态结论、五维条形、触发条件清单、
 * 参考价位（偏多/偏空时）、权重明细（可查看评分规则弹层）、数据缺口标注、免责行。
 */

import { SCORING_RULES } from '../scoring.js';
import { stockLabel } from '../names.js';
import { esc, fmtNum } from '../ui.js';

const CONCLUSION_STYLE = {
  bullish: { label: '偏多', cls: 'bg-rose-950 text-rose-300 border border-rose-800', icon: 'ri-arrow-up-double-line', ring: '#ef4444' },
  neutral: { label: '中性', cls: 'bg-slate-800 text-slate-300 border border-slate-600', icon: 'ri-subtract-line', ring: '#94a3b8' },
  bearish: { label: '偏空', cls: 'bg-emerald-950 text-emerald-300 border border-emerald-800', icon: 'ri-arrow-down-double-line', ring: '#22c55e' }
};

const DIM_COLOR = {
  trend: '#6366f1', momentum: '#f59e0b', volume: '#38bdf8',
  volatility: '#c084fc', position: '#f472b6', shortterm: '#fbbf24'
};

/** 评分条（横向） */
function dimBar(d) {
  const color = DIM_COLOR[d.key] || '#6366f1';
  const w = Math.max(2, Math.min(100, d.score));
  return `
  <div class="py-2">
    <div class="flex items-center justify-between text-xs mb-1">
      <span class="text-slate-300 font-medium flex items-center gap-1.5">
        <span class="w-2 h-2 rounded-full" style="background:${color}"></span>${esc(d.label)}
        <span class="text-slate-600">权重 ${d.weight}%</span>
      </span>
      <span class="tabular ${d.score >= 60 ? 'text-rise' : d.score <= 40 ? 'text-fall' : 'text-slate-300'}">${fmtNum(d.score, 1)}</span>
    </div>
    <div class="h-1.5 rounded-full bg-slate-800 overflow-hidden">
      <div class="h-full rounded-full transition-all duration-700" style="width:${w}%;background:${color}"></div>
    </div>
    ${d.reasons.length ? `<ul class="mt-1.5 space-y-0.5">
      ${d.reasons.map(r => `<li class="text-[11px] leading-relaxed text-slate-500 flex gap-1">
        <span class="${r.impact > 0 ? 'text-rise' : r.impact < 0 ? 'text-fall' : 'text-slate-600'} shrink-0">${r.impact > 0 ? '+' : r.impact < 0 ? '−' : '·'}${r.impact !== 0 ? Math.abs(r.impact) : ''}</span>
        <span>${esc(r.text)}</span></li>`).join('')}
    </ul>` : ''}
    ${d.missing.length ? `<p class="mt-1 text-[11px] text-amber-500/80"><i class="ri-alert-line"></i> ${esc(d.missing.join('；'))}</p>` : ''}
  </div>`;
}

/** 综合评分环形（SVG） */
function scoreRing(score, color) {
  const r = 52, c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  return `
  <svg width="140" height="140" viewBox="0 0 140 140" class="shrink-0">
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="#1e293b" stroke-width="10"/>
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="${color}" stroke-width="10"
      stroke-linecap="round" class="ring-score" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
      transform="rotate(-90 70 70)"/>
    <text x="70" y="66" text-anchor="middle" fill="#e2e8f0" font-size="30" font-weight="700" class="tabular">${score.toFixed(0)}</text>
    <text x="70" y="88" text-anchor="middle" fill="#64748b" font-size="11">综合评分</text>
  </svg>`;
}

/** 参考价位块 */
function levelRow(l, cls = '') {
  return `<div class="flex items-center justify-between text-xs py-1 ${cls}">
    <span class="text-slate-400">${esc(l.label)}</span>
    <span class="tabular ${l.cls || 'text-slate-200'}">${fmtNum(l.price)}</span>
  </div>`;
}

/**
 * 渲染评分面板。
 * @param {HTMLElement} el 容器
 * @param {object|null} state { klines, indicators }（个股视图状态）
 * @param {object} opts { code, name?, feature?, reason? }（name 缺省时用名称目录补全）
 */
export function renderScorePanel(el, state, opts = {}) {
  if (!el) return;

  // 标题统一用「名称 代码」；opts.name 已由调用方算好时可直接使用
  const title = opts.name || stockLabel(opts.code);

  // 动态 import 避免循环依赖（scoring.js 不依赖视图）
  import('../scoring.js').then(({ computeScore }) => {
    let result = null;
    if (state && state.klines && state.indicators) {
      result = computeScore(state.klines, state.indicators, { feature: opts.feature });
    }

    if (!result || !result.ok) {
      const gaps = result ? result.dataGaps : [opts.reason || '数据不足'];
      el.innerHTML = `
      <div class="card p-5">
        <h3 class="font-medium text-slate-200 text-sm mb-3 flex items-center gap-1.5">
          <i class="ri-dashboard-3-line text-indigo-400"></i>时机评分与建议 · ${esc(title)}
        </h3>
        <div class="flex flex-col items-center py-6 text-slate-500 gap-2">
          <i class="ri-indeterminate-circle-line text-3xl"></i>
          <p class="text-sm">暂无法生成评分</p>
          <p class="text-xs text-amber-500/80">${esc(gaps.join('；'))}</p>
        </div>
      </div>`;
      return;
    }

    const cs = CONCLUSION_STYLE[result.conclusion];
    const dims = result.dimensions;
    const wSum = dims.reduce((s, x) => s + x.weight, 0);

    el.innerHTML = `
    <div class="card p-5">
      <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h3 class="font-medium text-slate-200 text-sm flex items-center gap-1.5">
          <i class="ri-dashboard-3-line text-indigo-400"></i>时机评分与框架性建议 · ${esc(title)}
        </h3>
        <button id="btn-rules" class="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1">
          <i class="ri-question-line"></i>查看评分规则
        </button>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- 左：综合评分环 + 结论 + 权重 -->
        <div class="flex flex-col items-center justify-center gap-3">
          ${scoreRing(result.composite, cs.ring)}
          <span class="badge ${cs.cls} text-sm px-3 py-1"><i class="${cs.icon}"></i>${cs.label}</span>
          <p class="text-[11px] text-slate-500 text-center leading-relaxed">
            ${dims.map(d => `${esc(d.label)} ${d.weight / wSum * 100 > 0 ? (d.weight / wSum * 100).toFixed(0) : ''}%`).join(' · ')}
          </p>
        </div>

        <!-- 中：五维条 -->
        <div class="divide-y divide-slate-800/70">
          ${dims.map(d => dimBar(d)).join('')}
        </div>

        <!-- 右：建议与参考价位 -->
        <div class="space-y-3">
          ${
            result.conclusion === 'bullish' ? `
            <div class="rounded-lg border border-rose-900/60 bg-rose-950/30 p-3">
              <p class="text-xs text-rose-300 font-medium mb-1"><i class="ri-arrow-up-double-line"></i> 框架性建议：偏多</p>
              <p class="text-[11px] text-slate-400 leading-relaxed">多维度信号偏多。可关注回踩支撑的企稳信号，参考下方关注区间与止损位管理风险。</p>
            </div>` :
            result.conclusion === 'bearish' ? `
            <div class="rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-3">
              <p class="text-xs text-emerald-300 font-medium mb-1"><i class="ri-arrow-down-double-line"></i> 框架性建议：偏空</p>
              <p class="text-[11px] text-slate-400 leading-relaxed">多维度信号偏空。持有者可关注反弹压力位的减仓评估，空仓者建议等待企稳信号。</p>
            </div>` : `
            <div class="rounded-lg border border-slate-700 bg-slate-800/40 p-3">
              <p class="text-xs text-slate-300 font-medium mb-1"><i class="ri-subtract-line"></i> 框架性建议：中性观望</p>
              <p class="text-[11px] text-slate-400 leading-relaxed">多空信号交织，无明确方向。建议观望等待信号收敛，或缩小周期观察短线结构。</p>
            </div>`
          }

          ${result.refLevels ? `
          <div class="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <p class="text-xs text-slate-300 font-medium mb-1.5">参考价位</p>
            <p class="text-[10px] text-slate-500 mb-1">压力位（从近到远）</p>
            ${result.refLevels.resistances.slice(0, 3).map(l => levelRow(l, 'border-b border-slate-800/50')).join('')}
            <p class="text-[10px] text-slate-500 mt-2 mb-1">支撑位（从近到远）</p>
            ${result.refLevels.supports.slice(0, 3).map(l => levelRow(l, 'border-b border-slate-800/50')).join('')}
            ${result.refLevels.entryZone ? `
            <div class="mt-2 pt-2 border-t border-slate-800">
              <div class="flex items-center justify-between text-xs">
                <span class="text-rose-300">${esc(result.refLevels.entryZone.label)}</span>
                <span class="tabular text-rose-300">${fmtNum(result.refLevels.entryZone.low)} ~ ${fmtNum(result.refLevels.entryZone.high)}</span>
              </div>
              <p class="text-[10px] text-slate-500 mt-0.5">${esc(result.refLevels.entryZone.note)}</p>
            </div>` : ''}
            ${result.refLevels.stopRef ? `
            <div class="mt-2 pt-2 border-t border-slate-800">
              <div class="flex items-center justify-between text-xs">
                <span class="text-amber-300">${esc(result.refLevels.stopRef.label)}</span>
                <span class="tabular text-amber-300">${fmtNum(result.refLevels.stopRef.price)}</span>
              </div>
              <p class="text-[10px] text-slate-500 mt-0.5">${esc(result.refLevels.stopRef.note)}</p>
            </div>` : ''}
            <p class="text-[10px] text-slate-600 mt-2"><i class="ri-information-line"></i> ${esc(result.refLevels.disclaimer)}</p>
          </div>` : ''}

          ${result.dataGaps.length ? `
          <div class="rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
            <p class="text-xs text-amber-400/90 font-medium mb-1"><i class="ri-alert-line"></i> 数据缺口（降级说明）</p>
            <ul class="space-y-0.5">
              ${result.dataGaps.map(g => `<li class="text-[11px] text-amber-500/70 leading-relaxed">· ${esc(g)}</li>`).join('')}
            </ul>
          </div>` : ''}
        </div>
      </div>

      <!-- 触发条件清单 -->
      <details class="mt-4 group">
        <summary class="text-xs text-slate-400 cursor-pointer hover:text-slate-200 flex items-center gap-1 select-none">
          <i class="ri-arrow-right-s-line transition-transform group-open:rotate-90"></i>完整触发条件清单（${result.triggerList.length} 项）
        </summary>
        <div class="mt-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3 max-h-64 overflow-y-auto">
          <table class="w-full text-[11px]">
            <thead><tr class="text-slate-500 text-left">
              <th class="py-1 pr-2 font-normal w-16">维度</th><th class="py-1 pr-2 font-normal">触发依据</th><th class="py-1 font-normal w-12 text-right">影响</th>
            </tr></thead>
            <tbody class="divide-y divide-slate-800/60">
              ${result.triggerList.map(t => `<tr>
                <td class="py-1 pr-2 text-slate-400">${esc(t.dim)}</td>
                <td class="py-1 pr-2 text-slate-400 leading-relaxed">${esc(t.text)}</td>
                <td class="py-1 text-right tabular ${t.impact > 0 ? 'text-rise' : t.impact < 0 ? 'text-fall' : 'text-slate-600'}">${t.impact > 0 ? '+' : t.impact < 0 ? '−' : ''}${t.impact !== 0 ? Math.abs(t.impact) : ''}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </details>

      <p class="text-[10px] text-slate-600 mt-3 text-center">以上分析由历史数据与规则引擎推算 · 仅供个人研究参考</p>
    </div>`;

    // 评分规则弹层
    el.querySelector('#btn-rules')?.addEventListener('click', () => {
      showRulesModal(result.dimensions, wSum);
    });
  });
}

/** 评分规则弹层 */
function showRulesModal(dims, wSum) {
  const mask = document.createElement('div');
  mask.className = 'fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4';
  mask.innerHTML = `
    <div class="card max-w-2xl w-full max-h-[80vh] overflow-y-auto p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-medium text-slate-100 flex items-center gap-1.5"><i class="ri-file-list-3-line text-indigo-400"></i>评分规则说明</h3>
        <button class="btn btn-ghost !p-2" data-close><i class="ri-close-line"></i></button>
      </div>
      <p class="text-xs text-slate-400 mb-3 leading-relaxed">${esc(SCORING_RULES.weights)}</p>
      <div class="space-y-3">
        ${Object.entries(SCORING_RULES).filter(([k]) => k !== 'weights').map(([k, v]) => {
          const d = dims.find(x => x.key === k);
          const title = { trend: '趋势', momentum: '动量', volume: '量能', volatility: '波动率', position: '位置', shortterm: '短线情绪' }[k] || k;
          return `<div>
            <p class="text-xs font-medium text-slate-300 mb-1">${title}${d ? ` <span class="text-slate-500 font-normal">（当前权重 ${(d.weight / wSum * 100).toFixed(0)}%，得分 ${fmtNum(d.score, 1)}）</span>` : ' <span class="text-slate-500 font-normal">（未参与）</span>'}</p>
            <p class="text-[11px] text-slate-500 leading-relaxed">${esc(v)}</p>
          </div>`;
        }).join('')}
      </div>
      <p class="text-[10px] text-slate-600 mt-4">综合评分 = Σ(维度得分 × 归一权重) · 阈值：≥60 偏多 / ≤40 偏空 / 其余中性</p>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) mask.remove();
  });
}
