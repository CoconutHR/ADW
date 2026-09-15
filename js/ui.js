/**
 * ui.js — 通用 UI 工具：Toast、加载占位、空态、错误卡片、数字格式化
 */

/** 弹出 Toast 通知 */
export function toast(message, type = 'info', duration = 3200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const icons = { info: 'ri-information-line', success: 'ri-check-line', error: 'ri-close-circle-line', warn: 'ri-alert-line' };
  const colors = {
    info: 'bg-slate-800 border-slate-600 text-slate-200',
    success: 'bg-emerald-950 border-emerald-700 text-emerald-300',
    error: 'bg-rose-950 border-rose-800 text-rose-300',
    warn: 'bg-amber-950 border-amber-700 text-amber-300'
  };
  const el = document.createElement('div');
  el.className = `toast-item flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm shadow-lg max-w-sm ${colors[type] || colors.info}`;
  el.innerHTML = `<i class="${icons[type] || icons.info}"></i><span>${message}</span>`;
  root.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 260);
  }, duration);
}

/** 生成加载占位 HTML */
export function loadingHTML(text = '加载中…', minH = '160px') {
  return `<div class="flex flex-col items-center justify-center text-slate-500 gap-3" style="min-height:${minH}">
    <i class="ri-loader-4-line text-3xl pulse-soft"></i>
    <p class="text-sm">${text}</p>
  </div>`;
}

/** 生成空态占位 HTML */
export function emptyHTML(text = '暂无数据', icon = 'ri-inbox-line') {
  return `<div class="flex flex-col items-center justify-center text-slate-600 gap-2 py-10">
    <i class="${icon} text-4xl"></i>
    <p class="text-sm">${text}</p>
  </div>`;
}

/** 生成可重试错误卡片 HTML */
export function errorHTML(title, detail = '', retryAttr = '') {
  return `<div class="card p-6 text-center">
    <i class="ri-cloud-off-line text-3xl text-rose-400"></i>
    <p class="mt-2 font-medium text-rose-300">${title}</p>
    ${detail ? `<p class="mt-1 text-xs text-slate-500 max-w-xl mx-auto leading-relaxed">${detail}</p>` : ''}
    ${retryAttr ? `<button class="btn btn-ghost mt-4" ${retryAttr}><i class="ri-refresh-line"></i> 重试</button>` : ''}
  </div>`;
}

/** 数字格式化：保留 fixed 位，无效值返回占位 */
export function fmtNum(v, fixed = 2, placeholder = '--') {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(fixed) : placeholder;
}

/** 百分比格式化：0.0523 -> "5.23%"（入参已是百分数则直接格式化） */
export function fmtPct(v, signed = false, placeholder = '--') {
  const n = Number(v);
  if (!Number.isFinite(n)) return placeholder;
  const s = `${Math.abs(n).toFixed(2)}%`;
  if (!signed) return s;
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${s}`;
}

/** 量能/金额缩写：123456789 -> 1.23亿 */
export function fmtAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + '万亿';
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (abs >= 1e4) return (n / 1e4).toFixed(2) + '万';
  return n.toFixed(0);
}

/** 涨跌幅着色 span（A股红涨绿跌） */
export function pctSpan(v, opts = {}) {
  const n = Number(v);
  const cls = opts.muted ? '' : (n > 0 ? 'text-rise' : n < 0 ? 'text-fall' : 'text-slate-400');
  return `<span class="${cls} tabular">${fmtPct(n, true, opts.placeholder || '--')}</span>`;
}

/** HTML 转义 */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 生成信号徽章 HTML */
export function signalBadge(sig) {
  const map = {
    bullish: 'bg-rose-950 text-rose-300 border border-rose-900',
    bearish: 'bg-emerald-950 text-emerald-300 border border-emerald-900',
    neutral: 'bg-slate-800 text-slate-300 border border-slate-700'
  };
  const iconMap = { bullish: 'ri-arrow-up-line', bearish: 'ri-arrow-down-line', neutral: 'ri-subtract-line' };
  return `<span class="badge ${map[sig.direction] || map.neutral}"><i class="${iconMap[sig.direction] || iconMap.neutral}"></i>${esc(sig.label)}</span>`;
}

/** 更新顶部连接状态指示器 */
export function setConnStatus(status, text) {
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-text');
  if (!dot || !label) return;
  dot.className = 'w-2 h-2 rounded-full';
  if (status === 'on') dot.classList.add('on');
  else if (status === 'demo') dot.classList.add('demo');
  else dot.classList.add('off');
  label.textContent = text;
}
