/**
 * backtest-engine.test.js — 回验引擎单元自测
 * 用构造数据验证：N日收益计算、方向化口径、时间区间过滤、
 * 尾部未到期剔除、小样本标记、统计指标正确性。
 * 运行方式：node --experimental-vm-modules js/backtest-engine.test.js
 */

import { runBacktest, bucketDistribution, dateKey, MIN_SAMPLE_WARN } from './backtest-engine.js';
import { detectSignals } from './signal.js';
import { computeAll } from './indicators.js';

let passed = 0, failed = 0;
function assert(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
}

/** 构造先跌后涨再震荡的 K 线（能触发金叉/多头排列等看多信号） */
function dipThenRise(n = 160) {
  const rows = [];
  let p = 30;
  for (let i = 0; i < n; i++) {
    const falling = i < n * 0.4;
    const chg = falling ? -0.012 : 0.014;
    const prev = p;
    p = p * (1 + chg);
    const heavyVol = i > n * 0.3 && i < n * 0.5;
    rows.push({
      date: `D${String(i).padStart(4, '0')}`,
      open: prev, close: p,
      high: Math.max(prev, p) * 1.004, low: Math.min(prev, p) * 0.996,
      volume: heavyVol ? 500000 : 80000
    });
  }
  return rows;
}

/** 构造确定性数据：每根 +1% 的持续上涨 */
function steadyRise(n = 120) {
  const rows = [];
  let p = 10;
  for (let i = 0; i < n; i++) {
    const prev = p;
    p = p * 1.01;
    rows.push({
      date: `S${String(i).padStart(4, '0')}`,
      open: prev, close: p,
      high: p * 1.002, low: prev * 0.999,
      volume: 100000 + i * 500
    });
  }
  return rows;
}

export function runBacktestTests() {
  console.log('== 回验引擎单元自测 ==');

  // ---- 1. dateKey 归一化 ----
  {
    assert('dateKey 兼容 YYYYMMDD', dateKey('20240102') === '20240102');
    assert('dateKey 兼容 YYYY-MM-DD', dateKey('2024-01-02') === '20240102');
    assert('dateKey 截断带时间的日期', dateKey('2024-01-02 15:00:00') === '20240102');
  }

  // ---- 2. N 日收益计算：确定性数据手工核对 ----
  {
    const k = steadyRise(120);
    const N = 3;
    const res = runBacktest(k, { types: ['ma_bullish'], holdDays: N });
    assert('回验返回 ok', res.ok === true);
    assert('存在有效样本', res.trades.length > 0, `trades=${res.trades.length}`);
    // ma_bullish 触发于首个满足三线排列的位置，其 3 日后收益应精确等于 (p[i+3]/p[i]-1)
    for (const t of res.trades) {
      const i = t.index;
      const expect = (k[i + N].close / k[i].close) - 1;
      assert(`样本@${i} 的 rawRet 精确匹配`, Math.abs(t.rawRet - expect) < 1e-9, `rawRet=${t.rawRet} expect=${expect}`);
      assert(`样本@${i} 看多信号 ret=rawRet`, t.ret === t.rawRet);
    }
    assert('尾部未到期被剔除', res.skippedTail >= 0 && res.trades.every(t => t.index + N < k.length));
    assert('matchedCount 含尾部未到期', res.matchedCount >= res.trades.length);
  }

  // ---- 3. 方向化口径：看空信号 ret 取反 ----
  {
    const k = dipThenRise(200);
    const res = runBacktest(k, { types: ['macd_death', 'ma_bearish'], direction: 'bearish', holdDays: 5 });
    assert('筛选后样本全部为看空', res.trades.every(t => t.direction === 'bearish'));
    assert('看空样本 ret = -rawRet', res.trades.every(t => Math.abs(t.ret + t.rawRet) < 1e-12));
  }

  // ---- 4. 时间区间过滤 ----
  {
    const k = dipThenRise(200);
    const all = runBacktest(k, { holdDays: 5 });
    assert('无限区间包含全部匹配', all.matchedCount === detectSignals(k).signals.length);
    // 截取后半段
    const half = Math.floor(k.length / 2);
    const halfDate = k[half].date;
    const part = runBacktest(k, { startDate: halfDate, holdDays: 5 });
    assert('起始日期过滤生效', part.trades.every(t => t.date >= halfDate));
    assert('过滤后样本数 ≤ 全量', part.matchedCount <= all.matchedCount);
    // YYYY-MM-DD 格式同样生效
    const part2 = runBacktest(k, { startDate: halfDate.slice(1, 5) + '-' + halfDate.slice(5, 7) + '-' + halfDate.slice(7, 9).replace(/^D/, '01') , holdDays: 5 });
    assert('日期格式 YYYY-MM-DD 兼容', part2.ok === true);
  }

  // ---- 5. 统计指标正确性：构造已知收益序列 ----
  {
    // 构造一段 K 线，使某信号触发后 1 日收益可精确控制
    const k = steadyRise(100);
    const res = runBacktest(k, { types: ['ma_bullish'], holdDays: 2 });
    if (res.stats) {
      const s = res.stats;
      const rets = res.trades.map(t => t.ret * 100);
      const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
      assert('胜率样本数一致', s.samples === res.trades.length);
      assert('平均收益精确', Math.abs(s.avgReturn - avg) < 1e-9, `avgReturn=${s.avgReturn} expect=${avg}`);
      assert('持续上涨中看多信号胜率应为 100%', s.winRate === 100, `winRate=${s.winRate}`);
      assert('wins + losses + even = samples', s.wins + s.losses + s.even === s.samples);
      const sorted = [...rets].sort((a, b) => a - b);
      const n = sorted.length;
      const med = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      assert('中位收益正确', Math.abs(s.medianReturn - med) < 1e-9);
    } else {
      assert('存在样本时 stats 非空', false, 'stats 为空');
    }
  }

  // ---- 6. 尾部未到期与空区间 ----
  {
    const k = dipThenRise(160);
    const bigN = runBacktest(k, { holdDays: 120 });
    assert('大 N 时尾部剔除计数正确', bigN.skippedTail > 0 || bigN.trades.length === 0);
    // 无效区间：起晚于止
    const bad = runBacktest(k, { startDate: '2099-01-01', endDate: '2000-01-01', holdDays: 5 });
    assert('无效区间返回 0 样本但 ok', bad.ok === true && bad.trades.length === 0 && bad.stats === null);
  }

  // ---- 7. 小样本标记（需求 7.4） ----
  {
    const k = dipThenRise(160);
    const res = runBacktest(k, { holdDays: 5 });
    assert('样本不足阈值时 smallSample 标记',
      res.smallSample === (res.trades.length > 0 && res.trades.length < MIN_SAMPLE_WARN),
      `trades=${res.trades.length} smallSample=${res.smallSample}`);
    // 稳定上涨触发多头排列只一次 → 应为小样本
    const single = runBacktest(steadyRise(100), { types: ['ma_bullish'], holdDays: 2 });
    assert('单一样本被标记 smallSample', single.smallSample === true, `trades=${single.trades.length}`);
  }

  // ---- 8. 空数据边界（需求 7.3） ----
  {
    const res = runBacktest([], { holdDays: 5 });
    assert('空K线返回 ok=false', res.ok === false);
    assert('空K线给出明确原因', !!res.reason && res.reason.includes('无K线数据'));
    assert('空K线不输出统计', res.stats === null);
    const res2 = runBacktest(null, {});
    assert('null 输入同样安全', res2.ok === false);
  }

  // ---- 9. 收益分桶 ----
  {
    const dist = bucketDistribution([{ ret: 0.001 }, { ret: 0.03 }, { ret: -0.06 }]);
    assert('分桶总数守恒', dist.reduce((a, b) => a + b.count, 0) === 3);
    assert('0.1% 落入 0~2% 桶', dist[5].count === 1);
    assert('3% 落入 2~5% 桶', dist[6].count === 1);
    assert('-6% 落入 -8~-5% 桶', dist[2].count === 1);
    const empty = bucketDistribution([]);
    assert('空样本分桶计 0 且不 NaN', empty.every(b => b.count === 0 && b.pct === 0));
  }

  console.log(`== 自测完成：${passed} 通过，${failed} 失败 ==`);
  return { passed, failed };
}

// 直接运行（node ESM）时自动执行
if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('backtest-engine.test.js')) {
  runBacktestTests();
}
