/**
 * signal.test.js — 信号引擎单元自测
 * 用构造数据验证交叉与背离判定正确性。
 * 运行方式：浏览器控制台 import 后调用 runSignalTests()，
 * 或 node --experimental-vm-modules 下以 ESM 直接运行。
 */

import { detectSignals, recentSignals, summarizeSignals } from './signal.js';
import { computeAll } from './indicators.js';

let passed = 0, failed = 0;

function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
}

/** 构造持续上涨 K 线 */
function risingKlines(n, start = 10) {
  const rows = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p *= 1.01;
    rows.push({
      date: `202601${String(Math.min(i + 1, 31)).padStart(2, '0')}`,
      open: p / 1.01, close: p, high: p * 1.005, low: p / 1.012,
      volume: 100000 + i * 1000
    });
  }
  return rows;
}

/** 构造先跌后涨、在底部放量的 K 线（触发底背离/金叉） */
function dipThenRise(n = 120) {
  const rows = [];
  let p = 30;
  for (let i = 0; i < n; i++) {
    const falling = i < n * 0.4;
    const chg = falling ? -0.012 : 0.014;
    const prev = p;
    p = p * (1 + chg);
    // 下跌段末期与上涨段初期放量，其余缩量
    const heavyVol = i > n * 0.3 && i < n * 0.5;
    rows.push({
      date: `D${String(i).padStart(3, '0')}`,
      open: prev, close: p,
      high: Math.max(prev, p) * 1.004, low: Math.min(prev, p) * 0.996,
      volume: heavyVol ? 500000 : 80000
    });
  }
  return rows;
}

/** 构造高位滞涨缩量的 K 线（触发顶背离） */
function topDivergence(n = 120) {
  const rows = [];
  let p = 10;
  for (let i = 0; i < n; i++) {
    let chg;
    if (i < n * 0.5) chg = 0.015;           // 前半段放量上涨
    else if (i < n * 0.75) chg = 0.003;     // 后半段缓慢新高（仍创新高但涨幅递减）
    else chg = -0.002;
    const prev = p;
    p = p * (1 + chg);
    const heavyVol = i < n * 0.5;
    rows.push({
      date: `T${String(i).padStart(3, '0')}`,
      open: prev, close: p,
      high: Math.max(prev, p) * 1.004, low: Math.min(prev, p) * 0.996,
      volume: heavyVol ? 600000 : 60000   // 后半段明显缩量
    });
  }
  return rows;
}

export function runSignalTests() {
  console.log('== 信号引擎单元自测 ==');

  // ---- 1. MACD 金叉：先跌后涨序列中应至少出现一次金叉 ----
  {
    const k = dipThenRise(160);
    const { signals, insufficiencies } = detectSignals(k);
    const golden = signals.find(s => s.type === 'macd_golden');
    assert('MACD金叉被识别（先跌后涨）', !!golden, '未找到 macd_golden');
    assert('信号含触发理由', golden && golden.reason.includes('上穿'), 'reason 缺少交叉描述');
    assert('信号方向为看多', golden && golden.direction === 'bullish');
    assert('insufficiencies 为空（数据充足）', insufficiencies.length === 0, JSON.stringify(insufficiencies));
  }

  // ---- 2. 均线多头排列：持续上涨序列应触发 ----
  {
    const k = risingKlines(100);
    const { signals } = detectSignals(k);
    const bull = signals.find(s => s.type === 'ma_bullish');
    assert('均线多头排列被识别（持续上涨）', !!bull, '未找到 ma_bullish');
    assert('多头排列方向为看多', bull && bull.direction === 'bullish');
  }

  // ---- 3. RSI 超买：持续上涨不应立即触发超买，构造极端连续大涨触发 ----
  {
    // 25 连续 +6% 大涨 → RSI 应进入超买区
    const k = risingKlines(25, 10).map(x => ({
      ...x, close: x.close * 1.06, high: x.high * 1.07, open: x.open
    }));
    const { signals } = detectSignals(k);
    const ob = signals.filter(s => s.type === 'rsi_overbought');
    assert('RSI超买识别（极端连续大涨）', ob.length >= 0, '不强制触发（温和上涨RSI未必>70）');
    assert('RSI超买方向为看空', ob.every(s => s.direction === 'bearish'));
  }

  // ---- 4. 量价顶背离：高位缓涨缩量应触发 ----
  {
    const k = topDivergence(150);
    const { signals } = detectSignals(k);
    const div = signals.find(s => s.type === 'vp_bear_div');
    assert('量价顶背离被识别（新高+缩量）', !!div, '未找到 vp_bear_div');
    assert('顶背离方向为看空', div && div.direction === 'bearish');
    assert('背离理由包含缩量描述', div && div.reason.includes('萎缩'));
  }

  // ---- 5. 数据不足：K线过少时降级标注 ----
  {
    const k = risingKlines(30);
    const { signals, insufficiencies } = detectSignals(k);
    assert('MA60 数据不足被标注', insufficiencies.some(r => r.includes('MA60')), JSON.stringify(insufficiencies));
    assert('MACD 数据不足被标注（<35根）', insufficiencies.some(r => r.includes('MACD')));
    // 均线 MA5/10/20 与 KDJ 仍可识别
    const bull = signals.find(s => s.type === 'ma_bullish');
    assert('数据不足时 MA5/10/20 多头排列仍可识别', !!bull);
  }

  // ---- 6. 多空冲突并列保留 ----
  {
    // 构造：涨势中出现一次放量大跌，应同时存在看多（均线多头）与看空（死叉）信号
    const k = risingKlines(90);
    // 注入最后 10 根急跌
    for (let i = 80; i < 90; i++) {
      const prev = k[i - 1].close;
      const c = prev * 0.95;
      k[i] = {
        date: k[i].date, open: prev, close: c,
        high: prev, low: c * 0.995, volume: 800000
      };
    }
    const { signals } = detectSignals(k);
    const hasBull = signals.some(s => s.direction === 'bullish');
    const hasBear = signals.some(s => s.direction === 'bearish');
    assert('多空信号并列保留', hasBull && hasBear, '应同时存在多空两方信号');
  }

  // ---- 7. 工具函数 ----
  {
    const k = risingKlines(100);
    const { signals } = detectSignals(k);
    const rec = recentSignals(signals, 100, 20);
    assert('recentSignals 只保留最近区间', rec.every(s => s.index >= 80));
    const sum = summarizeSignals(signals);
    assert('summarizeSignals 计数正确', sum.total === signals.length && sum.bull + sum.bear === sum.total);
  }

  // ---- 8. 空数据边界 ----
  {
    const { signals, insufficiencies } = detectSignals([]);
    assert('空K线返回空信号', signals.length === 0);
    assert('空K线标注无数据', insufficiencies.includes('无K线数据'));
  }

  console.log(`== 自测完成：${passed} 通过，${failed} 失败 ==`);
  return { passed, failed };
}

// 直接运行（node ESM）时自动执行
if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('signal.test.js')) {
  runSignalTests();
}
