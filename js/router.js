/**
 * router.js — 极简哈希路由
 * 支持 #/stock、#/stock/600519、#/scan、#/market、#/backtest、#/config
 */

const routes = [];
let currentCleanup = null;

/** 注册路由：pattern 如 '/stock/:code'，handler(pathParams, query) 返回或异步设置视图 */
export function registerRoute(pattern, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  }) + '$');
  routes.push({ regex, keys, handler });
}

function parseHash() {
  const raw = (location.hash || '#/stock').slice(1); // 去掉 '#'
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart || '/stock';
  const query = {};
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      const [k, v] = pair.split('=');
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
  }
  return { path, query };
}

/** 触发一次路由分发 */
export async function dispatch() {
  const { path, query } = parseHash();
  // 优先静态匹配，其次参数匹配
  let matched = routes.find(r => r.regex.test(path) && r.keys.length === 0)
    || routes.find(r => r.regex.test(path));

  const root = document.getElementById('view-root');
  if (currentCleanup) { try { currentCleanup(); } catch { /* ignore */ } currentCleanup = null; }

  // 更新导航高亮
  document.querySelectorAll('.nav-link[data-nav]').forEach(el => {
    const seg = '/' + (path.split('/')[1] || '');
    el.classList.toggle('active', el.dataset.nav === seg);
  });

  if (!matched) {
    root.innerHTML = `<div class="card p-8 text-center text-slate-400">页面不存在，<a href="#/stock" class="text-indigo-400 underline">返回个股分析</a></div>`;
    return;
  }

  const params = {};
  const m = path.match(matched.regex);
  matched.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

  root.innerHTML = `<div class="view-enter" id="view-container"></div>`;
  const ctx = {
    container: document.getElementById('view-container'),
    params,
    query,
    onCleanup(fn) { currentCleanup = fn; }
  };
  try {
    await matched.handler(ctx);
  } catch (err) {
    console.error('[router] 视图渲染失败:', err);
    ctx.container.innerHTML = `<div class="card p-6 text-rose-400">
      <p class="font-medium mb-2"><i class="ri-error-warning-line"></i> 页面渲染出错</p>
      <p class="text-sm text-slate-400">${String(err && err.message || err)}</p>
    </div>`;
  }
}

/** 启动路由监听 */
export function startRouter() {
  window.addEventListener('hashchange', dispatch);
  if (!location.hash) location.hash = '#/stock';
  return dispatch();
}
