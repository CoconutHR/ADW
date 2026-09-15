/**
 * indicators.js — 技术指标计算库（纯函数，无副作用）
 * 输入统一为 K 线数组 [{open, high, low, close, volume, date, ...}]（按时间升序）
 * 输出为与 K 线等长的数组（无法计算的起始位置为 null），以及 meta 信息。
 *
 * 数据不足处理约定（需求 3.5）：
 *   - K 线根数 < 所需最小根数时，整个指标返回 { insufficient: true, reason } 
 *   - 起始 warming-up 区间对应位置为 null
 */

/**
 * 简单移动平均 MA(n)。
 * @returns {{values: (number|null)[], insufficient: boolean, reason?: string}}
 */
export function MA(klines, n) {
  const need = n;
  if (!Array.isArray(klines) || klines.length < need) {
    return { values: [], insufficient: true, reason: `K线不足 ${need} 根，无法计算 MA${n}` };
  }
  const values = new Array(klines.length).fill(null);
  let sum = 0;
  for (let i = 0; i < klines.length; i++) {
    sum += klines[i].close;
    if (i >= n) sum -= klines[i - n].close;
    if (i >= n - 1) values[i] = +(sum / n).toFixed(3);
  }
  return { values, insufficient: false };
}

/** 指数移动平均 EMA(n) 内部工具 */
export function EMA(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = null;
  // 以首 n 个值的均值作为初始 EMA
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    if (i < n) {
      sum += v;
      if (i === n - 1) {
        prev = sum / n;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/**
 * MACD(12,26,9)：DIF、DEA、MACD 柱。
 * @returns {{dif, dea, macd, insufficient, reason?}}
 */
export function MACD(klines, short = 12, long = 26, signal = 9) {
  const closes = klines.map(k => k.close);
  if (klines.length < long + signal) {
    return { dif: [], dea: [], macd: [], insufficient: true, reason: `K线不足 ${long + signal} 根，无法计算 MACD` };
  }
  const emaShort = EMA(closes, short);
  const emaLong = EMA(closes, long);
  const dif = closes.map((_, i) => {
    if (emaShort[i] == null || emaLong[i] == null) return null;
    return emaShort[i] - emaLong[i];
  });
  // DEA = DIF 的 EMA(signal)，忽略 null
  const difClean = dif.map(v => (v == null ? 0 : v));
  const deaRaw = EMA(difClean, signal);
  const dea = dif.map((v, i) => (v == null ? null : deaRaw[i]));
  const macd = dif.map((v, i) => {
    if (v == null || dea[i] == null) return null;
    return (v - dea[i]) * 2; // 国内惯例 MACD 柱 = (DIF-DEA)*2
  });
  return { dif, dea, macd, insufficient: false };
}

/**
 * RSI(n)（Wilder 平滑）。
 */
export function RSI(klines, n = 14) {
  if (klines.length < n + 1) {
    return { values: [], insufficient: true, reason: `K线不足 ${n + 1} 根，无法计算 RSI${n}` };
  }
  const values = new Array(klines.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < klines.length; i++) {
    const ch = klines[i].close - klines[i - 1].close;
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (i <= n) {
      avgGain += gain / n;
      avgLoss += loss / n;
      if (i === n) {
        values[i] = avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);
      }
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      values[i] = avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);
    }
  }
  return { values, insufficient: false };
}

/**
 * KDJ(9,3,3)：K、D、J。
 */
export function KDJ(klines, n = 9, m1 = 3, m2 = 3) {
  if (klines.length < n) {
    return { k: [], d: [], j: [], insufficient: true, reason: `K线不足 ${n} 根，无法计算 KDJ` };
  }
  const k = new Array(klines.length).fill(null);
  const d = new Array(klines.length).fill(null);
  const j = new Array(klines.length).fill(null);
  let prevK = 50, prevD = 50;
  for (let i = 0; i < klines.length; i++) {
    if (i < n - 1) continue;
    let hh = -Infinity, ll = Infinity;
    for (let t = i - n + 1; t <= i; t++) {
      hh = Math.max(hh, klines[t].high);
      ll = Math.min(ll, klines[t].low);
    }
    const rsv = hh === ll ? 50 : ((klines[i].close - ll) / (hh - ll)) * 100;
    const curK = (2 / m1) * prevK + (1 / m1) * rsv;
    const curD = (2 / m2) * prevD + (1 / m2) * curK;
    const curJ = 3 * curK - 2 * curD;
    k[i] = +curK.toFixed(2);
    d[i] = +curD.toFixed(2);
    j[i] = +curJ.toFixed(2);
    prevK = curK; prevD = curD;
  }
  return { k, d, j, insufficient: false };
}

/**
 * BOLL(20,2)：MID、UPPER、LOWER。
 */
export function BOLL(klines, n = 20, p = 2) {
  if (klines.length < n) {
    return { mid: [], upper: [], lower: [], insufficient: true, reason: `K线不足 ${n} 根，无法计算 BOLL` };
  }
  const mid = new Array(klines.length).fill(null);
  const upper = new Array(klines.length).fill(null);
  const lower = new Array(klines.length).fill(null);
  for (let i = n - 1; i < klines.length; i++) {
    let sum = 0;
    for (let t = i - n + 1; t <= i; t++) sum += klines[t].close;
    const m = sum / n;
    let sq = 0;
    for (let t = i - n + 1; t <= i; t++) sq += (klines[t].close - m) ** 2;
    const sd = Math.sqrt(sq / n);
    mid[i] = +m.toFixed(3);
    upper[i] = +(m + p * sd).toFixed(3);
    lower[i] = +(m - p * sd).toFixed(3);
  }
  return { mid, upper, lower, insufficient: false };
}

/**
 * 一次性计算全部指标（供个股视图与评分引擎复用）。
 * @returns {{ ma5, ma10, ma20, ma60, macd, rsi14, kdj, boll, insufficiencies: string[] }}
 */
export function computeAll(klines) {
  const result = {
    ma5: MA(klines, 5), ma10: MA(klines, 10), ma20: MA(klines, 20), ma60: MA(klines, 60),
    macd: MACD(klines), rsi14: RSI(klines, 14), kdj: KDJ(klines), boll: BOLL(klines),
    insufficiencies: []
  };
  for (const [key, ind] of Object.entries({ MA5: result.ma5, MA10: result.ma10, MA20: result.ma20, MA60: result.ma60, MACD: result.macd, RSI14: result.rsi14, KDJ: result.kdj, BOLL: result.boll })) {
    if (ind && ind.insufficient) result.insufficiencies.push(ind.reason || key);
  }
  return result;
}
