/**
 * signal.js — 信号识别引擎
 * 识别经典买卖形态：MACD 金叉/死叉、RSI 超买超卖、KDJ 金叉/死叉、
 * 均线多空排列、量价背离。
 *
 * 输出结构化信号列表：{ direction, type, label, index, date, price, reason }
 * 多空冲突时并列保留双方信号，不强行合并（需求 3.3）。
 */

import { computeAll } from './indicators.js';

/** 信号识别参数（可被 detectSignals opts.config 覆盖） */
export const SIGNAL_CONFIG = {
  rsiOverbought: 70,      // RSI 超买阈值
  rsiOversold: 30,        // RSI 超卖阈值
  kdjLow: 30,             // KDJ 低位金叉判定阈值
  kdjHigh: 70,            // KDJ 高位死叉判定阈值
  divWindow: 20,          // 量价背离观察窗口（根）
  divShrinkRatio: 0.85,   // 量能萎缩判定：当日量 < 前窗口均量 * 该比例
};

/** 信号类型 → 展示标签 */
export const SIGNAL_LABELS = {
  macd_golden: 'MACD金叉',
  macd_death: 'MACD死叉',
  rsi_overbought: 'RSI超买',
  rsi_oversold: 'RSI超卖',
  kdj_golden: 'KDJ金叉',
  kdj_death: 'KDJ死叉',
  ma_bullish: '均线多头排列',
  ma_bearish: '均线空头排列',
  vp_bear_div: '量价顶背离',
  vp_bull_div: '量价底背离',
};

/** 信号类型 → 方向（供筛选 UI、回验分组等静态查阅） */
export const SIGNAL_TYPE_DIRECTIONS = {
  macd_golden: 'bullish', macd_death: 'bearish',
  rsi_overbought: 'bearish', rsi_oversold: 'bullish',
  kdj_golden: 'bullish', kdj_death: 'bearish',
  ma_bullish: 'bullish', ma_bearish: 'bearish',
  vp_bear_div: 'bearish', vp_bull_div: 'bullish',
};

/** 构造信号对象并推入列表 */
function push(out, direction, type, klines, i, reason) {
  const k = klines[i];
  out.push({
    direction,          // 'bullish' | 'bearish'
    type,               // SIGNAL_LABELS 的 key
    label: SIGNAL_LABELS[type],
    index: i,           // 触发位置（K 线下标）
    date: k.date ?? String(i),
    price: k.close,
    reason,             // 触发理由（含指标数值）
  });
}

/** MACD 金叉/死叉：DIF 与 DEA 交叉 */
function detectMacdCross(klines, macd, out) {
  const { dif, dea } = macd;
  for (let i = 1; i < klines.length; i++) {
    const d0 = dif[i - 1], e0 = dea[i - 1], d1 = dif[i], e1 = dea[i];
    if (d0 == null || e0 == null || d1 == null || e1 == null) continue;
    if (d0 <= e0 && d1 > e1) {
      push(out, 'bullish', 'macd_golden', klines, i,
        `DIF(${d1.toFixed(3)})上穿DEA(${e1.toFixed(3)})，短期动能转强`);
    } else if (d0 >= e0 && d1 < e1) {
      push(out, 'bearish', 'macd_death', klines, i,
        `DIF(${d1.toFixed(3)})下穿DEA(${e1.toFixed(3)})，短期动能转弱`);
    }
  }
}

/** RSI 超买/超卖：进入阈值区间的首根触发 */
function detectRsiZone(klines, values, cfg, out) {
  for (let i = 0; i < klines.length; i++) {
    const v = values[i];
    if (v == null) continue;
    const prev = i > 0 ? values[i - 1] : null;
    if (v > cfg.rsiOverbought && (prev == null || prev <= cfg.rsiOverbought)) {
      push(out, 'bearish', 'rsi_overbought', klines, i,
        `RSI14=${v.toFixed(1)}进入超买区（>${cfg.rsiOverbought}），短期涨幅过大，注意回落风险`);
    } else if (v < cfg.rsiOversold && (prev == null || prev >= cfg.rsiOversold)) {
      push(out, 'bullish', 'rsi_oversold', klines, i,
        `RSI14=${v.toFixed(1)}进入超卖区（<${cfg.rsiOversold}），短期超跌，存在反弹动能`);
    }
  }
}

/** KDJ 金叉/死叉：K 与 D 交叉，标注低位/高位增强语义 */
function detectKdjCross(klines, kdj, cfg, out) {
  const { k, d } = kdj;
  for (let i = 1; i < klines.length; i++) {
    const k0 = k[i - 1], d0 = d[i - 1], k1 = k[i], d1 = d[i];
    if (k0 == null || d0 == null || k1 == null || d1 == null) continue;
    if (k0 <= d0 && k1 > d1) {
      const lowNote = k1 < cfg.kdjLow ? `，且处于低位（K<${cfg.kdjLow}），反弹信号较强` : '';
      push(out, 'bullish', 'kdj_golden', klines, i,
        `K(${k1.toFixed(1)})上穿D(${d1.toFixed(1)})${lowNote}`);
    } else if (k0 >= d0 && k1 < d1) {
      const highNote = k1 > cfg.kdjHigh ? `，且处于高位（K>${cfg.kdjHigh}），回调风险较大` : '';
      push(out, 'bearish', 'kdj_death', klines, i,
        `K(${k1.toFixed(1)})下穿D(${d1.toFixed(1)})${highNote}`);
    }
  }
}

/** 均线多空排列：MA5/MA10/MA20 三线排列状态切换时触发 */
function detectMaAlignment(klines, ind, out) {
  const { ma5, ma10, ma20 } = ind;
  if (ma5.insufficient || ma10.insufficient || ma20.insufficient) return;
  let prevBull = false, prevBear = false;
  for (let i = 0; i < klines.length; i++) {
    const a = ma5.values[i], b = ma10.values[i], c = ma20.values[i];
    if (a == null || b == null || c == null) { prevBull = false; prevBear = false; continue; }
    const bull = a > b && b > c;
    const bear = a < b && b < c;
    if (bull && !prevBull) {
      push(out, 'bullish', 'ma_bullish', klines, i,
        `MA5(${a.toFixed(2)})>MA10(${b.toFixed(2)})>MA20(${c.toFixed(2)})，均线多头排列，中期趋势偏多`);
    } else if (bear && !prevBear) {
      push(out, 'bearish', 'ma_bearish', klines, i,
        `MA5(${a.toFixed(2)})<MA10(${b.toFixed(2)})<MA20(${c.toFixed(2)})，均线空头排列，中期趋势偏空`);
    }
    prevBull = bull;
    prevBear = bear;
  }
}

/** close[i] 是否严格高于前 W 根全部收盘价 */
function windowHigh(klines, i, W) {
  if (i < W) return false;
  const c = klines[i].close;
  for (let t = i - W; t < i; t++) {
    if (!(klines[t].close < c)) return false;
  }
  return true;
}

/** close[i] 是否严格低于前 W 根全部收盘价 */
function windowLow(klines, i, W) {
  if (i < W) return false;
  const c = klines[i].close;
  for (let t = i - W; t < i; t++) {
    if (!(klines[t].close > c)) return false;
  }
  return true;
}

/** 当日量是否较前 W 根均量明显萎缩 */
function volShrink(klines, i, W, ratio) {
  if (i < W || !Number.isFinite(Number(klines[i].volume))) return false;
  let sum = 0;
  for (let t = i - W; t < i; t++) sum += Number(klines[t].volume) || 0;
  const avg = sum / W;
  return avg > 0 && Number(klines[i].volume) < avg * ratio;
}

/**
 * 量价背离：以状态切换触发，避免连续新高/新低时重复刷屏。
 * - 顶背离（看跌）：创窗口新高 + 量能萎缩 → 上攻动能不足
 * - 底背离（看涨）：创窗口新低 + 量能萎缩 → 抛压衰竭
 */
function detectDivergence(klines, cfg, out) {
  const W = cfg.divWindow;
  let prevHighShrink = false, prevLowShrink = false;
  for (let i = W; i < klines.length; i++) {
    const hs = windowHigh(klines, i, W) && volShrink(klines, i, W, cfg.divShrinkRatio);
    const ls = windowLow(klines, i, W) && volShrink(klines, i, W, cfg.divShrinkRatio);
    if (hs && !prevHighShrink) {
      push(out, 'bearish', 'vp_bear_div', klines, i,
        `股价创${W}日新高但量能萎缩（低于前${W}日均量85%），上攻动能不足，疑似量价顶背离`);
    }
    if (ls && !prevLowShrink) {
      push(out, 'bullish', 'vp_bull_div', klines, i,
        `股价创${W}日新低且量能萎缩，抛压趋于衰竭，疑似量价底背离`);
    }
    prevHighShrink = hs;
    prevLowShrink = ls;
  }
}

/**
 * 信号识别总入口。
 * @param {array} klines K线数组（升序）
 * @param {object} opts { indicators?: computeAll 的结果（复用避免重算）, config?: 参数覆盖 }
 * @returns {{ signals, insufficiencies, indicators }}
 */
export function detectSignals(klines, opts = {}) {
  if (!Array.isArray(klines) || klines.length === 0) {
    return { signals: [], insufficiencies: ['无K线数据'], indicators: null };
  }
  const indicators = opts.indicators || computeAll(klines);
  const cfg = { ...SIGNAL_CONFIG, ...(opts.config || {}) };
  const insufficiencies = indicators.insufficiencies || [];
  const signals = [];

  if (!indicators.macd.insufficient) detectMacdCross(klines, indicators.macd, signals);
  if (!indicators.rsi14.insufficient) detectRsiZone(klines, indicators.rsi14.values, cfg, signals);
  if (!indicators.kdj.insufficient) detectKdjCross(klines, indicators.kdj, cfg, signals);
  detectMaAlignment(klines, indicators, signals);
  detectDivergence(klines, cfg, signals);

  signals.sort((a, b) => a.index - b.index);
  return { signals, insufficiencies, indicators };
}

/** 取最近 lastN 根内的信号（供侧栏/扫描列表展示） */
export function recentSignals(signals, klineCount, lastN = 30) {
  const from = Math.max(0, klineCount - lastN);
  return signals.filter(s => s.index >= from);
}

/** 汇总多空信号数量 */
export function summarizeSignals(signals) {
  const bull = signals.filter(s => s.direction === 'bullish').length;
  const bear = signals.filter(s => s.direction === 'bearish').length;
  return { bull, bear, total: signals.length };
}
