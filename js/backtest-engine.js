/**
 * backtest-engine.js — 历史信号回验统计引擎（纯函数，无副作用）
 *
 * 统计口径（页面与测试共用，务必一致）：
 * - 买入基准：信号触发日收盘价（信号收盘后确认，回验统一以触发日收盘计）
 * - 卖出基准：触发后第 N 个交易日（holdDays）收盘价
 * - 方向化收益：看多信号 ret = (exit-entry)/entry；
 *   看空信号 ret = (entry-exit)/entry，即价格下跌记为正向收益。
 *   胜率按“信号方向与随后走势一致”统计，多空信号口径统一。
 * - 尾部未到期：触发位置距数据末端不足 N 根的信号不计入样本，单独计数（skippedTail）。
 */

import { computeAll } from './indicators.js';
import { detectSignals } from './signal.js';

/** 样本量低于该值时标记 smallSample，UI 提示谨慎解读（需求 7.4） */
export const MIN_SAMPLE_WARN = 8;

/** 持有天数合法范围 */
export const HOLD_MIN = 1;
export const HOLD_MAX = 120;

/**
 * 日期归一化：提取前 8 位数字，兼容 '20240102' / '2024-01-02' / '2024-01-02 15:00'。
 * @returns {string} 如 '20240102'（异常输入可能返回较短串，仍可按字典序比较）
 */
export function dateKey(d) {
  return String(d ?? '').replace(/\D/g, '').slice(0, 8);
}

/** 收益分布直方图分桶（方向化收益 %，左闭右开，末桶开区间） */
export const RET_BUCKETS = [
  { label: '<-12%', min: -Infinity, max: -12 },
  { label: '-12~-8%', min: -12, max: -8 },
  { label: '-8~-5%', min: -8, max: -5 },
  { label: '-5~-2%', min: -5, max: -2 },
  { label: '-2~0%', min: -2, max: 0 },
  { label: '0~2%', min: 0, max: 2 },
  { label: '2~5%', min: 2, max: 5 },
  { label: '5~8%', min: 5, max: 8 },
  { label: '8~12%', min: 8, max: 12 },
  { label: '≥12%', min: 12, max: Infinity },
];

/** 将交易样本按收益分桶（用于直方图） */
export function bucketDistribution(trades) {
  const counts = RET_BUCKETS.map(() => 0);
  const list = Array.isArray(trades) ? trades : [];
  for (const t of list) {
    const v = Number(t.ret) * 100;
    if (!Number.isFinite(v)) continue;
    for (let bi = 0; bi < RET_BUCKETS.length; bi++) {
      const b = RET_BUCKETS[bi];
      if (v >= b.min && v < b.max) { counts[bi]++; break; }
    }
  }
  const total = list.length;
  return RET_BUCKETS.map((b, i) => ({
    ...b,
    count: counts[i],
    pct: total ? (counts[i] / total) * 100 : 0
  }));
}

/** 收益统计（trades 用于计算整体指标与定位最佳/最差样本） */
function computeStats(trades) {
  const rets = trades.map(t => t.ret);
  const sorted = [...rets].sort((a, b) => a - b);
  const n = rets.length;
  const sum = rets.reduce((a, b) => a + b, 0);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const wins = rets.filter(r => r > 0).length;
  const even = rets.filter(r => r === 0).length;

  let worst = trades[0], best = trades[0];
  for (const t of trades) {
    if (t.ret < worst.ret) worst = t;
    if (t.ret > best.ret) best = t;
  }

  return {
    samples: n,
    wins,
    losses: n - wins - even,
    even,
    winRate: (wins / n) * 100,
    avgReturn: (sum / n) * 100,
    medianReturn: median * 100,
    maxLoss: worst.ret * 100,     // 最大单笔亏损（方向化口径，≤0）
    maxGain: best.ret * 100,      // 最大单笔盈利
    worstTrade: worst,
    bestTrade: best,
  };
}

/**
 * 回验主入口。
 * @param {array} klines K线数组（升序）
 * @param {object} opts
 *   - types:       信号类型 key 数组（SIGNAL_LABELS 的键），null/空数组 = 全部
 *   - direction:   'all' | 'bullish' | 'bearish'
 *   - startDate:   起始日期（'YYYY-MM-DD' 或 'YYYYMMDD'，空 = 不限制）
 *   - endDate:     结束日期（同上）
 *   - holdDays:    持有交易日数 N
 *   - indicators:  可复用的 computeAll 结果（避免重算）
 * @returns {object} 见字段注释
 */
export function runBacktest(klines, opts = {}) {
  const {
    types = null,
    direction = 'all',
    startDate = '',
    endDate = '',
    holdDays = 5,
    indicators = null,
  } = opts;

  const N = Math.max(HOLD_MIN, Math.min(HOLD_MAX, Math.floor(Number(holdDays) || 5)));

  // 空数据：明确提示，不输出任何统计（需求 7.3）
  if (!Array.isArray(klines) || klines.length === 0) {
    return {
      ok: false,
      reason: '无K线数据，无法回验。请确认股票代码与服务数据',
      holdDays: N,
      matchedCount: 0,
      trades: [],
      stats: null,
      skippedTail: 0,
      insufficiencies: [],
      smallSample: false,
      minSampleWarn: MIN_SAMPLE_WARN,
      klineCount: 0,
      dataRange: null,
    };
  }

  const ind = indicators || computeAll(klines);
  const det = detectSignals(klines, { indicators: ind });
  const insufficiencies = det.insufficiencies || [];

  // 过滤：方向 / 类型 / 时间区间
  const sKey = dateKey(startDate);
  const eKey = dateKey(endDate);
  const typeSet = Array.isArray(types) && types.length ? new Set(types) : null;

  const matched = det.signals.filter(s => {
    if (direction !== 'all' && s.direction !== direction) return false;
    if (typeSet && !typeSet.has(s.type)) return false;
    const k = dateKey(s.date);
    if (sKey && k < sKey) return false;
    if (eKey && k > eKey) return false;
    return true;
  });

  // 逐信号计算 N 日收益
  const trades = [];
  let skippedTail = 0;

  for (const s of matched) {
    const i = s.index;
    const exitIdx = i + N;
    if (exitIdx >= klines.length) { skippedTail++; continue; }  // 尾部未到期
    const entry = klines[i].close;
    const exit = klines[exitIdx].close;
    if (!Number.isFinite(entry) || !Number.isFinite(exit) || !(entry > 0)) continue;

    const rawRet = (exit - entry) / entry;                     // 实际价格涨跌（小数）
    const ret = s.direction === 'bullish' ? rawRet : -rawRet; // 方向化收益

    trades.push({
      index: i,
      date: s.date,
      exitDate: klines[exitIdx].date,
      direction: s.direction,
      type: s.type,
      label: s.label,
      reason: s.reason,
      entryPrice: entry,
      exitPrice: exit,
      rawRet,
      ret,
      holdDays: N,
    });
  }

  trades.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.index - b.index));

  return {
    ok: true,
    reason: null,
    holdDays: N,
    matchedCount: matched.length,      // 区间内匹配触发总次数（含尾部未到期）
    trades,                            // 有效样本
    stats: trades.length ? computeStats(trades) : null,
    skippedTail,
    insufficiencies,
    smallSample: trades.length > 0 && trades.length < MIN_SAMPLE_WARN,
    minSampleWarn: MIN_SAMPLE_WARN,
    klineCount: klines.length,
    dataRange: [klines[0].date, klines[klines.length - 1].date],
  };
}
