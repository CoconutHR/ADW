/**
 * main.js — 应用入口
 * 注册各视图路由并启动路由器；
 * 启动时处理全局演示横幅与连接状态指示。
 */

import { startRouter, registerRoute } from './router.js';
import { getConfig, APP_VERSION } from './store.js';
import { healthCheck } from './api.js';
import { ensureNames } from './names.js';
import { setConnStatus } from './ui.js';

// 注册各页面视图
import { registerStockView } from './views/stock.js';
import { registerScanView } from './views/scan.js';
import { registerMarketView } from './views/market.js';
import { registerBacktestView } from './views/backtest.js';
import { registerConfigView } from './views/config.js';

registerStockView(registerRoute);
registerScanView(registerRoute);
registerMarketView(registerRoute);
registerBacktestView(registerRoute);
registerConfigView(registerRoute);

/** 全局演示数据横幅与连接状态 */
function initGlobalStatus() {
  const cfg = getConfig();

  if (cfg.demoMode) {
    setConnStatus('demo', '演示数据');
    const banner = document.createElement('div');
    banner.className = 'demo-banner text-amber-100 text-xs text-center py-1.5 font-medium';
    banner.innerHTML = `<i class="ri-flask-line"></i> 当前为演示数据模式 — 页面数据均为内置模拟数据，不代表真实行情。可在 <a href="#/config" class="underline font-bold">配置页</a> 关闭`;
    const header = document.querySelector('header');
    header && header.insertAdjacentElement('afterend', banner);
  } else {
    setConnStatus('off', '未连接');
    // 异步健康检查，不打断首屏渲染
    (async () => {
      // healthCheck 内部会先解析可用地址：默认 8666 被 AxData 的 CORS 白名单拒绝时，
      // 自动切换到页面自身的同源代理（server.py），无需手工改配置
      const r = await healthCheck();
      if (r.ok) setConnStatus('on', '已连接');
      else setConnStatus('off', '连接失败');
    })();
  }
}

console.info(`[AxData 时机面板] 当前版本 ${APP_VERSION}。若与最新发布不符，说明浏览器在用旧缓存或本地文件未同步，请强制刷新（Cmd/Ctrl+Shift+R）`);
initGlobalStatus();
startRouter();

// 后台预热证券名称目录：AxData 的行情接口不返回证券名称，
// 预热后各处即可显示「名称 代码」并支持按名称搜索（缓存 24 小时，失败静默）
ensureNames();
