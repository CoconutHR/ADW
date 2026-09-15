/**
 * views/config.js — 配置视图
 * - AxData 服务地址配置（默认 http://127.0.0.1:8666），持久化
 * - 测试连接（GET /health）
 * - CORS / 反向代理 / 混合内容指引
 * - 演示数据模式开关
 */

import { getConfig, saveConfig, markBaseUrlCustom, APP_VERSION } from '../store.js';
import { healthCheck, autoDetectBaseUrl, probeBaseUrl, resetBaseUrlCache } from '../api.js';
import { toast } from '../ui.js';

const CORS_GUIDE = `
<h4 class="font-medium text-slate-200 mb-2 flex items-center gap-1.5"><i class="ri-shield-cross-line text-amber-400"></i>跨域（CORS）/ 混合内容排查指引</h4>
<ol class="list-decimal list-inside space-y-1.5 text-xs text-slate-400 leading-relaxed">
  <li><b>推荐：同源代理（零配置）</b>：面板（8080）与 AxData（8666）端口不同即视为跨域，AxData 未放行面板来源时预检会被拒（服务日志可见 <code class="text-indigo-300">OPTIONS /v1/... 400</code>）。使用项目自带的 <code class="text-indigo-300">server.py</code> 一键同源启动：
    <pre class="bg-slate-950 border border-slate-800 rounded p-2 mt-1 overflow-x-auto text-[11px] leading-relaxed">python3 server.py
# 面板 http://127.0.0.1:8080 ，/health 与 /v1/* 自动代理到 AxData
# 面板会自动探测并选中该地址，无需手工填写</pre>
  </li>
  <li><b>地址自动探测</b>：启动时按「页面自身地址 → <code class="text-indigo-300">127.0.0.1:8080</code> → <code class="text-indigo-300">127.0.0.1:8666</code>」顺序探测，选中首个可用地址；一旦直连 8666 被 AxData 的 CORS 白名单拒绝，会自动回落到同源代理。若右上角仍显示「连接失败」，说明候选地址全部不可达。</li>
  <li><b>服务端放行 CORS</b>：AxData 基于 FastAPI，需在应用中添加 CORSMiddleware（uvicorn 本身没有 CORS 参数）：
    <pre class="bg-slate-950 border border-slate-800 rounded p-2 mt-1 overflow-x-auto text-[11px] leading-relaxed">from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8080"],  # 面板来源
    allow_methods=["*"], allow_headers=["*"],
)</pre>
  </li>
  <li><b>HTTPS 页面访问 HTTP API（混合内容限制）</b>：若本面板通过 https:// 打开（如云端预览环境），浏览器会阻止访问本机 HTTP 服务。此时请将面板下载到本地以 http:// 方式打开，或使用上面的代理方案。</li>
  <li><b>Nginx 反代</b>：将面板静态文件与 <code class="text-indigo-300">/v1/</code> 同域代理，效果同方案一：
    <pre class="bg-slate-950 border border-slate-800 rounded p-2 mt-1 overflow-x-auto text-[11px] leading-relaxed">location /v1/ { proxy_pass http://127.0.0.1:8666/v1/; }
location /health { proxy_pass http://127.0.0.1:8666/health; }</pre>
  </li>
  <li><b>防火墙/端口</b>：确认 8666 端口已监听（<code class="text-indigo-300">lsof -iTCP:8666 -sTCP:LISTEN</code>），且鉴权模式为 local open 时仅允许本机回环访问。</li>
</ol>`;

export function registerConfigView(registerRoute) {
  registerRoute('/config', async (ctx) => {
    const cfg = getConfig();
    const { container } = ctx;

    container.innerHTML = `
    <div class="max-w-3xl mx-auto space-y-5">

      <div class="flex items-center gap-2 mb-1">
        <i class="ri-settings-3-line text-xl text-indigo-400"></i>
        <h2 class="text-lg font-bold text-slate-100">服务配置</h2>
        <span class="text-[10px] font-mono text-indigo-300 bg-indigo-950/60 border border-indigo-900/60 rounded px-1.5 py-0.5">${APP_VERSION}</span>
      </div>

      <!-- 连接配置卡片 -->
      <div class="card p-5">
        <h3 class="font-medium text-slate-200 mb-4 flex items-center gap-1.5">
          <i class="ri-server-line text-indigo-400"></i>AxData 服务连接
        </h3>
        <div class="space-y-4">
          <div>
            <label class="block text-xs text-slate-400 mb-1.5">服务地址（Base URL）</label>
            <input id="cfg-baseurl" class="field font-mono" value="${cfg.baseUrl}" placeholder="http://127.0.0.1:8666" spellcheck="false">
            <p class="text-[11px] text-slate-500 mt-1.5">你已部署的后端 API 地址，默认 <code class="text-indigo-300">http://127.0.0.1:8666</code>（local open 免 token）。8667 为 AxData 自带 Web 控制台，面板不依赖。通过 <code class="text-indigo-300">server.py</code> 打开面板时，填面板自身的地址（如 <code class="text-indigo-300">http://127.0.0.1:8080</code>）即可走同源代理；启动时会按顺序自动探测，无需手工填写。</p>
          </div>
          <div>
            <label class="block text-xs text-slate-400 mb-1.5">请求路径模板</label>
            <input id="cfg-path" class="field font-mono" value="${cfg.pathTemplate}" placeholder="/v1/request/{api}" spellcheck="false">
            <p class="text-[11px] text-slate-500 mt-1.5">数据请求约定：<code class="text-indigo-300">{api}</code> 为接口名占位符（如 stock_kline_daily_tdx）。若你的 AxData 版本接口路径不同，可在此调整，无需改代码。</p>
          </div>
          <div>
            <label class="block text-xs text-slate-400 mb-1.5">请求超时（秒）</label>
            <input id="cfg-timeout" type="number" min="3" max="60" class="field w-32" value="${Math.round((cfg.timeoutMs || 10000) / 1000)}">
          </div>
          <div class="flex items-center gap-3 pt-1">
            <button id="btn-save" class="btn btn-primary"><i class="ri-save-line"></i>保存配置</button>
            <button id="btn-test" class="btn btn-ghost"><i class="ri-pulse-line"></i>测试连接</button>
            <button id="btn-autodetect" class="btn btn-ghost"><i class="ri-radar-line"></i>自动检测</button>
            <span id="test-result" class="text-sm"></span>
          </div>
        </div>
      </div>

      <!-- 演示数据模式 -->
      <div class="card p-5">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 class="font-medium text-slate-200 flex items-center gap-1.5">
              <i class="ri-flask-line text-amber-400"></i>演示数据模式
            </h3>
            <p class="text-xs text-slate-500 mt-1.5 max-w-md leading-relaxed">AxData 服务不可达时，可开启演示模式：以内置模拟数据驱动完整界面（K线、信号、评分、扫描、回验），便于预览面板功能与排查问题。开启后所有页面顶部会标注"演示数据"。</p>
          </div>
          <button id="btn-demo" role="switch" aria-checked="${cfg.demoMode}" class="shrink-0 relative w-12 h-6 rounded-full transition-colors ${cfg.demoMode ? 'bg-amber-500' : 'bg-slate-700'}">
            <span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${cfg.demoMode ? 'translate-x-6' : ''}"></span>
          </button>
        </div>
      </div>

      <!-- CORS 指引 -->
      <div class="card p-5">
        ${CORS_GUIDE}
      </div>

    </div>`;

    // ---- 事件绑定 ----
    const $ = (id) => container.querySelector('#' + id);

    $('btn-save').addEventListener('click', () => {
      const baseUrl = $('cfg-baseurl').value.trim().replace(/\/+$/, '');
      const pathTemplate = $('cfg-path').value.trim() || '/v1/request/{api}';
      const timeoutSec = Math.max(3, Math.min(60, Number($('cfg-timeout').value) || 10));
      if (!/^https?:\/\//.test(baseUrl)) {
        toast('服务地址需以 http:// 或 https:// 开头', 'error');
        return;
      }
      saveConfig({ baseUrl, pathTemplate, timeoutMs: timeoutSec * 1000 });
      markBaseUrlCustom();  // 视为用户明确指定的地址，后续启动以它为准
      resetBaseUrlCache();  // 地址已变更，作废缓存的解析结果
      toast('配置已保存', 'success');
    });

    // 测试连接：如实检测输入框中填写的地址；不通时再尝试自动兜底，并明确告知已切换
    $('btn-test').addEventListener('click', async () => {
      const result = $('test-result');
      const typed = $('cfg-baseurl').value.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(typed)) {
        toast('服务地址需以 http:// 或 https:// 开头', 'error');
        return;
      }
      result.innerHTML = `<span class="text-slate-400 text-xs"><i class="ri-loader-4-line pulse-soft"></i> 检测中…</span>`;

      const persist = (baseUrl) => {
        saveConfig({
          baseUrl,
          pathTemplate: $('cfg-path').value.trim() || '/v1/request/{api}',
          timeoutMs: Math.max(3, Math.min(60, Number($('cfg-timeout').value) || 10)) * 1000
        });
        markBaseUrlCustom();
        resetBaseUrlCache();
      };

      const r = await healthCheck(typed);  // 只测用户填的地址，不自动切换
      if (r.ok) {
        persist(typed);
        result.innerHTML = `<span class="text-emerald-400 text-xs"><i class="ri-check-line"></i> 连接成功 ${r.body && r.body.status ? '· 服务状态 ' + r.body.status : ''}</span>`;
        toast('AxData 服务连接成功', 'success');
        return;
      }

      // 填写的地址不通：探测可用地址兜底，并如实说明原地址为何不可用
      const alt = await autoDetectBaseUrl([typed]);
      if (alt) {
        persist(alt);
        $('cfg-baseurl').value = alt;
        result.innerHTML = `<span class="text-amber-400 text-xs"><i class="ri-alert-line"></i> ${typed} 不可用，已切换到 ${alt}</span>`;
        toast(`${typed} 不可用：${r.reason}。已自动切换到 ${alt}`, 'warn', 6000);
      } else {
        result.innerHTML = `<span class="text-rose-400 text-xs"><i class="ri-close-line"></i> ${r.reason}</span>`;
        toast('连接失败：' + r.reason, 'error', 5000);
      }
    });

    // 自动检测：逐候选地址探测 /health，命中即回填输入框并保存
    $('btn-autodetect').addEventListener('click', async () => {
      const result = $('test-result');
      const btn = $('btn-autodetect');
      btn.disabled = true;
      result.innerHTML = `<span class="text-slate-400 text-xs"><i class="ri-loader-4-line pulse-soft"></i> 正在探测可用地址…</span>`;

      const manual = $('cfg-baseurl').value.trim().replace(/\/+$/, '');
      // 手工填写的地址优先验证，失败再走候选列表
      const manualOk = !!manual && await probeBaseUrl(manual);
      const found = manualOk ? manual : await autoDetectBaseUrl();

      btn.disabled = false;
      if (!found) {
        result.innerHTML = `<span class="text-rose-400 text-xs"><i class="ri-close-line"></i> 未探测到可用地址</span>`;
        toast('未探测到可用的 AxData 服务，请确认后端已启动', 'error', 5000);
        return;
      }
      $('cfg-baseurl').value = found;
      if (manualOk) markBaseUrlCustom();  // 采纳的是用户填写的地址；自动探测结果不锁定
      resetBaseUrlCache();
      saveConfig({
        baseUrl: found,
        pathTemplate: $('cfg-path').value.trim() || '/v1/request/{api}',
        timeoutMs: Math.max(3, Math.min(60, Number($('cfg-timeout').value) || 10)) * 1000
      });
      result.innerHTML = `<span class="text-emerald-400 text-xs"><i class="ri-check-line"></i> 已切换到 ${found}</span>`;
      toast('已自动切换到可用地址：' + found, 'success');
    });

    $('btn-demo').addEventListener('click', () => {
      const next = !getConfig().demoMode;
      saveConfig({ demoMode: next });
      resetBaseUrlCache();  // 演示模式会跳过地址解析，切换后需重新解析
      $('btn-demo').setAttribute('aria-checked', String(next));
      $('btn-demo').className = `shrink-0 relative w-12 h-6 rounded-full transition-colors ${next ? 'bg-amber-500' : 'bg-slate-700'}`;
      $('btn-demo').querySelector('span').className = `absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${next ? 'translate-x-6' : ''}`;
      toast(next ? '已开启演示数据模式，页面即将刷新' : '已关闭演示数据模式，页面即将刷新', 'warn');
      setTimeout(() => location.reload(), 600);
    });
  });
}
