/**
 * scoring.js — 五维时机评分引擎
 * 维度：趋势(25%) 动量(20%) 量能(15%) 波动率(15%) 位置(25%)
 * 特色短线指标可用时追加"短线情绪"维度(15%)，其余维度权重等比归一。
 * 每维输出 0-100 得分与依据；综合评分 → 三态结论（偏多/中性/偏空）。
 * 关键数据缺失时降级评分并标注缺口（需求 4.5）。
 */

import { normalizeFeature } from './normalize.js';

export const DIM_DEFS = [
  { key: 'trend', label: '趋势', weight: 25 },
  { key: 'momentum', label: '动量', weight: 20 },
  { key: 'volume', label: '量能', weight: 15 },
  { key: 'volatility', label: '波动率', weight: 15 },
  { key: 'position', label: '位置', weight: 25 },
];
export const SHORT_DIM = { key: 'shortterm', label: '短线情绪', weight: 15 };

/** 评分规则说明（面板"查看评分规则"弹层使用） */
export const SCORING_RULES = {
  trend: '均线排列（MA5>MA10>MA20 多头 +20 / 空头 -20）；收盘价站上/跌破 MA20（±10）；MA20 五日斜率方向（±10）；收盘价相对 MA60（±10，MA60 不可用时不计分并标注缺口）。基准 50 分。',
  momentum: 'MACD：DIF 与 DEA 相对位置（±12）、柱体增减方向（±6）；RSI14 分区（55-70 强势 +12 / >70 超买 -8 / 30-45 偏弱 -8 / <30 超卖 +4）；KDJ 的 K/D 相对位置（±10）；近5日涨跌幅（±5）。基准 50 分。',
  volume: '当日量相对 20 日均量：显著放量(≥1.8倍) +15 / 温和放量 +8 / 明显缩量(<0.7倍) -10；近10日阳线日均量 vs 阴线日均量（放量上涨 +10 / 放量下跌 -8）。基准 50 分。',
  volatility: 'ATR14/收盘价：低波动(<1.5%) +15 / 正常(1.5-5%) +8~0 / 高波动(>5%) -12；BOLL 带宽收口(<8%) +6（变盘窗口）/ 过宽(>25%) -6。波动适中、形态收敛视为时机更优。',
  position: '60日区间相对位置：中位趋势区(35-65) +10 / 临近压力(≥85) -12 / 临近支撑(≤15) +8；BOLL 通道内位置（超上轨 -10 / 破下轨超卖 +6）；相对 MA20 乖离（贴近 +5 / 乖离过大 -5）。',
  shortterm: 'AxData 特色指标（可用时）：竞价昨比 ≥3% +15 / <0.5% -10；开盘量比 ≥2 +12 / <0.5 -10；开盘换手 ≥3% +8 / <0.3% -5。字段缺失不计分并标注。',
  weights: '五维基准权重：趋势 25 / 动量 20 / 量能 15 / 波动率 15 / 位置 25。特色指标可用时追加短线情绪 15，全部权重等比归一至 100%。综合评分 ≥60 偏多、≤40 偏空、其余中性。',
};

const clamp = (v, lo = 5, hi = 95) => Math.max(lo, Math.min(hi, v));

/** 取数组最后一个非空值 */
function lastVal(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}
function valAt(arr, i) { return (Array.isArray(arr) && i >= 0 && i < arr.length) ? arr[i] : null; }

/** 维度构造器 */
function dim(key, label, weight) {
  return { key, label, weight, score: 50, reasons: [], missing: [] };
}
function addReason(d, text, impact) {
  d.reasons.push({ text, impact });
  d.score += impact;
}

// ---------- 趋势 ----------
function scoreTrend(k, ind, d) {
  const n = k.length;
  const c = k[n - 1].close;
  const { ma5, ma10, ma20, ma60 } = ind;

  if (ma5.insufficient || ma10.insufficient || ma20.insufficient) {
    d.missing.push('均线数据不足，趋势维度按 MA20/MA60 缺失降级');
    d.score = 50;
    return;
  }
  const a = lastVal(ma5.values), b = lastVal(ma10.values), m = lastVal(ma20.values);
  if (a > b && b > m) addReason(d, `均线多头排列：MA5(${a.toFixed(2)})>MA10(${b.toFixed(2)})>MA20(${m.toFixed(2)})，中期趋势偏多`, +20);
  else if (a < b && b < m) addReason(d, `均线空头排列：MA5(${a.toFixed(2)})<MA10(${b.toFixed(2)})<MA20(${m.toFixed(2)})，中期趋势偏空`, -20);

  if (c > m) addReason(d, `收盘价 ${c.toFixed(2)} 站上 MA20(${m.toFixed(2)})`, +10);
  else addReason(d, `收盘价 ${c.toFixed(2)} 跌破 MA20(${m.toFixed(2)})`, -10);

  const mPrev = valAt(ma20.values, n - 6);
  if (mPrev != null) {
    if (m > mPrev) addReason(d, 'MA20 五日斜率向上，中期趋势改善', +10);
    else addReason(d, 'MA20 五日斜率向下，中期趋势走弱', -10);
  }

  if (ma60.insufficient) {
    d.missing.push('MA60 数据不足（K线 < 60 根），未计入长期趋势比对');
  } else {
    const l = lastVal(ma60.values);
    if (l != null) {
      if (c > l) addReason(d, `收盘价高于 MA60(${l.toFixed(2)})，长期趋势支撑`, +10);
      else addReason(d, `收盘价低于 MA60(${l.toFixed(2)})，长期趋势承压`, -10);
    }
  }
  d.score = clamp(d.score);
}

// ---------- 动量 ----------
function scoreMomentum(k, ind, d) {
  const n = k.length;
  const c = k[n - 1].close;

  if (!ind.macd.insufficient) {
    const dif = lastVal(ind.macd.dif), dea = lastVal(ind.macd.dea);
    const h = valAt(ind.macd.macd, n - 1), hPrev = valAt(ind.macd.macd, n - 2);
    if (dif != null && dea != null) {
      if (dif > dea) addReason(d, `MACD DIF(${dif.toFixed(3)}) 位于 DEA(${dea.toFixed(3)}) 上方，多头动能占优`, +12);
      else addReason(d, `MACD DIF(${dif.toFixed(3)}) 位于 DEA(${dea.toFixed(3)}) 下方，空头动能占优`, -12);
    }
    if (h != null && hPrev != null) {
      if (h > hPrev) addReason(d, 'MACD 柱体放大，动能增强', +6);
      else addReason(d, 'MACD 柱体收缩，动能衰减', -6);
    }
  } else d.missing.push('MACD 数据不足，未计入动量');

  if (!ind.rsi14.insufficient) {
    const r = lastVal(ind.rsi14.values);
    if (r != null) {
      if (r >= 70) addReason(d, `RSI14=${r.toFixed(1)} 超买，短期过热`, -8);
      else if (r >= 55) addReason(d, `RSI14=${r.toFixed(1)} 强势区间`, +12);
      else if (r >= 45) addReason(d, `RSI14=${r.toFixed(1)} 中性区间`, 0);
      else if (r >= 30) addReason(d, `RSI14=${r.toFixed(1)} 偏弱区间`, -8);
      else addReason(d, `RSI14=${r.toFixed(1)} 超卖，存在反弹动能但趋势偏弱`, +4);
    }
  } else d.missing.push('RSI 数据不足，未计入动量');

  if (!ind.kdj.insufficient) {
    const kk = lastVal(ind.kdj.k), dd = lastVal(ind.kdj.d);
    if (kk != null && dd != null) {
      if (kk > dd) addReason(d, `KDJ K(${kk.toFixed(1)})>D(${dd.toFixed(1)})，短线偏多`, +10);
      else addReason(d, `KDJ K(${kk.toFixed(1)})<D(${dd.toFixed(1)})，短线偏空`, -10);
    }
  } else d.missing.push('KDJ 数据不足，未计入动量');

  if (n >= 6) {
    const r5 = (c / k[n - 6].close - 1) * 100;
    if (r5 > 3) addReason(d, `近5日累计上涨 ${r5.toFixed(1)}%，短期强势`, +5);
    else if (r5 > 0) addReason(d, `近5日累计上涨 ${r5.toFixed(1)}%`, +3);
    else if (r5 < -3) addReason(d, `近5日累计下跌 ${r5.toFixed(1)}%，短期走弱`, -5);
    else addReason(d, `近5日累计下跌 ${r5.toFixed(1)}%`, -3);
  }
  d.score = clamp(d.score);
}

// ---------- 量能 ----------
function scoreVolume(k, ind, d) {
  const n = k.length;
  const W = Math.min(20, n - 1);
  if (W < 5) { d.missing.push('K线过少，量能维度降级'); d.score = 50; return; }

  let sum = 0;
  for (let i = n - W - 1; i < n - 1; i++) sum += Number(k[i].volume) || 0;
  const avg = sum / W;
  const today = Number(k[n - 1].volume) || 0;

  if (avg > 0) {
    const ratio = today / avg;
    if (ratio >= 1.8) addReason(d, `当日量为20日均量的 ${ratio.toFixed(1)} 倍，显著放量`, +15);
    else if (ratio >= 1.2) addReason(d, `当日量为20日均量的 ${ratio.toFixed(1)} 倍，温和放量`, +8);
    else if (ratio < 0.7) addReason(d, `当日量仅为20日均量的 ${ratio.toFixed(1)} 倍，明显缩量`, -10);
    else d.reasons.push({ text: `量能常态（${ratio.toFixed(1)} 倍均量）`, impact: 0 });
  }

  // 近10日阳线/阴线量对比
  const look = Math.min(10, n - 1);
  let upVol = 0, upCnt = 0, downVol = 0, downCnt = 0;
  for (let i = n - look; i < n; i++) {
    if (i <= 0) continue;
    const v = Number(k[i].volume) || 0;
    if (k[i].close >= k[i - 1].close) { upVol += v; upCnt++; }
    else { downVol += v; downCnt++; }
  }
  if (upCnt > 0 && downCnt > 0) {
    const uv = upVol / upCnt, dv = downVol / downCnt;
    if (uv > dv * 1.1) addReason(d, '近10日上涨日均量高于下跌日，量价配合偏多', +10);
    else if (dv > uv * 1.1) addReason(d, '近10日下跌日均量高于上涨日，抛压偏重', -8);
    else d.reasons.push({ text: '近10日涨跌量能大体均衡', impact: 0 });
  }
  d.score = clamp(d.score);
}

// ---------- 波动率 ----------
function scoreVolatility(k, ind, d) {
  const n = k.length;
  const W = Math.min(14, n - 1);
  if (W < 5) { d.missing.push('K线过少，波动率维度降级'); d.score = 50; return; }

  const c = k[n - 1].close;
  let trSum = 0;
  for (let i = n - W; i < n; i++) {
    const prevClose = k[i - 1].close;
    trSum += Math.max(k[i].high - k[i].low, Math.abs(k[i].high - prevClose), Math.abs(k[i].low - prevClose));
  }
  const atrPct = (trSum / W / c) * 100;

  if (atrPct < 1.5) addReason(d, `ATR波动率 ${atrPct.toFixed(2)}%，走势平稳`, +15);
  else if (atrPct < 3) addReason(d, `ATR波动率 ${atrPct.toFixed(2)}%，波动正常`, +8);
  else if (atrPct < 5) addReason(d, `ATR波动率 ${atrPct.toFixed(2)}%，波动偏高`, 0);
  else addReason(d, `ATR波动率 ${atrPct.toFixed(2)}%，波动剧烈，风险较高`, -12);

  if (!ind.boll.insufficient) {
    const up = lastVal(ind.boll.upper), lo = lastVal(ind.boll.lower), mid = lastVal(ind.boll.mid);
    if (up != null && lo != null && mid > 0) {
      const bw = (up - lo) / mid * 100;
      if (bw < 8) addReason(d, `BOLL带宽 ${bw.toFixed(1)}% 收口，面临方向选择`, +6);
      else if (bw > 25) addReason(d, `BOLL带宽 ${bw.toFixed(1)}% 过宽，波动风险大`, -6);
      else d.reasons.push({ text: `BOLL带宽 ${bw.toFixed(1)}% 正常`, impact: 0 });
    }
  } else d.missing.push('BOLL 数据不足，未计入波动率');
  d.score = clamp(d.score);
}

// ---------- 位置 ----------
function scorePosition(k, ind, d) {
  const n = k.length;
  const W = Math.min(60, n);
  if (W < 10) { d.missing.push('K线过少，位置维度降级'); d.score = 50; return; }

  const c = k[n - 1].close;
  let hi = -Infinity, lo = Infinity;
  for (let i = n - W; i < n; i++) { hi = Math.max(hi, k[i].high); lo = Math.min(lo, k[i].low); }
  const range = hi - lo;
  const pos = range > 0 ? (c - lo) / range * 100 : 50;

  if (pos >= 85) addReason(d, `处于${W}日区间 ${(pos).toFixed(0)}% 高位，临近压力 ${hi.toFixed(2)}`, -12);
  else if (pos >= 65) addReason(d, `处于${W}日区间 ${pos.toFixed(0)}% 偏高位置`, +6);
  else if (pos >= 35) addReason(d, `处于${W}日区间 ${pos.toFixed(0)}% 中位，趋势延续观察区`, +10);
  else if (pos >= 15) addReason(d, `处于${W}日区间 ${pos.toFixed(0)}% 偏低位置`, +4);
  else addReason(d, `处于${W}日区间 ${pos.toFixed(0)}% 低位，接近支撑 ${lo.toFixed(2)}`, +8);

  if (!ind.boll.insufficient) {
    const up = lastVal(ind.boll.upper), loB = lastVal(ind.boll.lower);
    if (up != null && loB != null && up > loB) {
      const bp = (c - loB) / (up - loB);
      if (bp > 1) addReason(d, '收盘价超出 BOLL 上轨，短线超涨', -10);
      else if (bp < 0) addReason(d, '收盘价跌破 BOLL 下轨，短线超卖', +6);
      else d.reasons.push({ text: `BOLL通道内位置 ${(bp * 100).toFixed(0)}%`, impact: 0 });
    }
  }

  if (!ind.ma20.insufficient) {
    const m = lastVal(ind.ma20.values);
    if (m != null && m > 0) {
      const dev = (c - m) / m * 100;
      if (Math.abs(dev) < 2) addReason(d, `贴近 MA20（乖离 ${dev.toFixed(1)}%），支撑/压力参考意义强`, +5);
      else if (dev > 10) addReason(d, `高于 MA20 乖离 ${dev.toFixed(1)}%，回归压力增大`, -5);
      else if (dev < -10) addReason(d, `低于 MA20 乖离 ${dev.toFixed(1)}%，超跌乖离`, +3);
    }
  }
  d.score = clamp(d.score);
}

// ---------- 短线情绪（特色指标） ----------
function scoreShortterm(featureRow, d) {
  const f = featureRow ? normalizeFeature(featureRow) : null;
  if (!f) { d.missing.push('特色指标数据源不可用，短线情绪维度未参与评分'); return false; }

  let any = false;
  if (f.auctionYesterdayRatio != null) {
    any = true;
    const v = f.auctionYesterdayRatio;
    if (v >= 3) addReason(d, `竞价昨比 ${v.toFixed(2)}%，竞价明显异动，资金关注度高`, +15);
    else if (v >= 1.5) addReason(d, `竞价昨比 ${v.toFixed(2)}%，竞价活跃`, +8);
    else if (v < 0.5) addReason(d, `竞价昨比 ${v.toFixed(2)}%，竞价冷清`, -10);
    else d.reasons.push({ text: `竞价昨比 ${v.toFixed(2)}%`, impact: 0 });
  } else d.missing.push('竞价昨比字段缺失');

  if (f.openVolumeRatio != null) {
    any = true;
    const v = f.openVolumeRatio;
    if (v >= 2) addReason(d, `开盘量比 ${v.toFixed(2)}，开盘显著放量`, +12);
    else if (v < 0.5) addReason(d, `开盘量比 ${v.toFixed(2)}，开盘缩量`, -10);
    else d.reasons.push({ text: `开盘量比 ${v.toFixed(2)}`, impact: 0 });
  } else d.missing.push('开盘量比字段缺失');

  if (f.openTurnover != null) {
    any = true;
    const v = f.openTurnover;
    if (v >= 3) addReason(d, `开盘换手 ${v.toFixed(2)}%，开盘换手充分`, +8);
    else if (v < 0.3) addReason(d, `开盘换手 ${v.toFixed(2)}%，开盘交投清淡`, -5);
    else d.reasons.push({ text: `开盘换手 ${v.toFixed(2)}%`, impact: 0 });
  } else d.missing.push('开盘换手字段缺失');

  if (!any) {
    d.missing.push('特色指标无有效数值，短线情绪维度未参与评分');
    return false;
  }
  d.score = clamp(d.score);
  return true;
}

/** 参考价位推算（需求 4.4：由历史数据推算，仅供参考） */
function computeRefLevels(k, ind, conclusion) {
  const n = k.length;
  const last = k[n - 1];
  const win20 = Math.min(20, n), win60 = Math.min(60, n);
  const ext = (w) => {
    let hi = -Infinity, lo = Infinity;
    for (let i = n - w; i < n; i++) { hi = Math.max(hi, k[i].high); lo = Math.min(lo, k[i].low); }
    return { hi, lo };
  };
  const e20 = ext(win20), e60 = ext(win60);

  const levels = {
    supports: [
      { label: `近${win20}日低点`, price: +e20.lo.toFixed(2) },
      { label: `近${win60}日低点`, price: +e60.lo.toFixed(2) },
    ],
    resistances: [
      { label: `近${win20}日高点`, price: +e20.hi.toFixed(2) },
      { label: `近${win60}日高点`, price: +e60.hi.toFixed(2) },
    ],
    notes: []
  };
  if (!ind.boll.insufficient) {
    const up = lastVal(ind.boll.upper), lo = lastVal(ind.boll.lower);
    if (up != null) levels.resistances.push({ label: 'BOLL上轨', price: +up.toFixed(2) });
    if (lo != null) levels.supports.push({ label: 'BOLL下轨', price: +lo.toFixed(2) });
  }
  if (!ind.ma20.insufficient) {
    const m = lastVal(ind.ma20.values);
    if (m != null) levels.supports.push({ label: 'MA20', price: +m.toFixed(2) });
  }

  levels.supports.sort((a, b) => b.price - a.price);   // 支撑从高到低
  levels.resistances.sort((a, b) => a.price - b.price); // 压力从低到高

  if (conclusion === 'bullish') {
    const ma20v = !ind.ma20.insufficient ? lastVal(ind.ma20.values) : null;
    const stop = ma20v != null ? Math.max(ma20v, e20.lo) : e20.lo;
    levels.stopRef = { label: '止损参考', price: +stop.toFixed(2), note: '跌破则多头结构破坏' };
    const ma5v = !ind.ma5.insufficient ? lastVal(ind.ma5.values) : null;
    const ma10v = !ind.ma10.insufficient ? lastVal(ind.ma10.values) : null;
    levels.entryZone = {
      label: '关注区间',
      low: ma10v != null ? +Math.min(ma5v || last.close, ma10v).toFixed(2) : +e20.lo.toFixed(2),
      high: ma5v != null ? +Math.max(ma5v, ma10v || ma5v).toFixed(2) : +last.close.toFixed(2),
      note: '回踩均线不破可关注；放量突破压力位亦为介入信号'
    };
  } else if (conclusion === 'bearish') {
    const ma10v = !ind.ma10.insufficient ? lastVal(ind.ma10.values) : null;
    levels.stopRef = { label: '反弹压力', price: +(ma10v != null ? Math.max(ma10v, e20.hi) : e20.hi).toFixed(2), note: '反弹至该位附近承压，持有者可评估减仓' };
    levels.entryZone = null;
  } else {
    levels.stopRef = null;
    levels.entryZone = null;
  }
  levels.disclaimer = '以上参考价位均由历史数据推算，仅供参考';
  return levels;
}

/**
 * 评分总入口。
 * @param {array} klines 升序K线
 * @param {object} indicators computeAll 结果
 * @param {object} opts { feature?: 特色指标原始行 }
 * @returns {object|null} 评分结果；K线过少返回降级对象
 */
export function computeScore(klines, indicators, opts = {}) {
  if (!Array.isArray(klines) || klines.length < 30 || !indicators) {
    return {
      ok: false,
      dataGaps: ['K线数据不足 30 根（或指标未计算），无法生成完整评分'],
      dimensions: [], composite: null, conclusion: null, refLevels: null
    };
  }

  const dims = [];
  const t = dim('trend', '趋势', DIM_DEFS[0].weight); scoreTrend(klines, indicators, t); dims.push(t);
  const mo = dim('momentum', '动量', DIM_DEFS[1].weight); scoreMomentum(klines, indicators, mo); dims.push(mo);
  const vo = dim('volume', '量能', DIM_DEFS[2].weight); scoreVolume(klines, indicators, vo); dims.push(vo);
  const vl = dim('volatility', '波动率', DIM_DEFS[3].weight); scoreVolatility(klines, indicators, vl); dims.push(vl);
  const po = dim('position', '位置', DIM_DEFS[4].weight); scorePosition(klines, indicators, po); dims.push(po);

  // 短线情绪维度（特色指标可用时）
  const st = dim('shortterm', SHORT_DIM.label, SHORT_DIM.weight);
  const stOk = scoreShortterm(opts.feature || null, st);
  if (stOk) dims.push(st);

  // 权重归一
  const wSum = dims.reduce((s, x) => s + x.weight, 0);
  const composite = +(dims.reduce((s, x) => s + x.score * (x.weight / wSum), 0)).toFixed(1);

  const conclusion = composite >= 60 ? 'bullish' : composite <= 40 ? 'bearish' : 'neutral';
  const conclusionLabel = { bullish: '偏多', neutral: '中性', bearish: '偏空' }[conclusion];

  const dataGaps = dims.flatMap(x => x.missing);
  if (indicators.insufficiencies && indicators.insufficiencies.length) {
    dataGaps.push(...indicators.insufficiencies);
  }

  return {
    ok: true,
    dimensions: dims,
    composite,
    conclusion,
    conclusionLabel,
    refLevels: conclusion !== 'neutral' ? computeRefLevels(klines, indicators, conclusion) : computeRefLevels(klines, indicators, 'neutral'),
    dataGaps,
    triggerList: dims.flatMap(d => d.reasons.map(r => ({ dim: d.label, text: r.text, impact: r.impact })))
  };
}
