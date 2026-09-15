/**
 * normalize.js — 数据归一化
 * 将 AxData 各 Provider 返回的行映射为面板统一结构，兼容多种字段命名。
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 从行对象中按候选字段名列表取第一个有效值 */
function pick(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return undefined;
}

/** 提取 6 位数字证券代码（兼容 '002141.SZ' / 'sz002141' / '002141' 等格式） */
function code6(v) {
  const s = String(v ?? '');
  const m = s.match(/\d{6}/);
  return m ? m[0] : s;
}

/** K 线时间归一化：兼容 ISO 格式（如 2026-05-19T15:00:00+08:00）
 *  日/周线收盘时刻（15:00/00:00）仅保留日期；分钟线保留到 HH:mm 以区分同日多根 */
function normKlineDate(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (m) {
    const hm = `${m[2]}:${m[3]}`;
    return (hm === '15:00' || hm === '00:00') ? m[1] : `${m[1]} ${hm}`;
  }
  return s;
}

/** 归一化 K 线行：{date, open, high, low, close, volume, amount, turnover} */
export function normalizeKline(row) {
  return {
    date: normKlineDate(pick(row, ['date', 'trade_date', 'trade_time', 'day', 'datetime', 'time'])),
    open: num(pick(row, ['open', 'open_price'])),
    high: num(pick(row, ['high', 'high_price'])),
    low: num(pick(row, ['low', 'low_price'])),
    close: num(pick(row, ['close', 'close_price', 'price'])),
    volume: num(pick(row, ['volume', 'vol', 'total_volume'])),
    amount: num(pick(row, ['amount', 'turnover_value', 'total_amount'])),
    turnover: num(pick(row, ['turnover', 'turnover_rate']))
  };
}

/** 归一化 K 线数组：过滤无效行、按日期升序、去重 */
export function normalizeKlines(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const list = [];
  for (const r of rows) {
    const k = normalizeKline(r);
    // 至少需要 date + close 有效
    if (!k.date || k.close == null) continue;
    if (seen.has(k.date)) continue;
    seen.add(k.date);
    list.push(k);
  }
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return list;
}

/** 归一化实时快照 */
export function normalizeSnapshot(row) {
  const price = num(pick(row, ['price', 'last', 'last_price', 'close']));
  const preClose = num(pick(row, ['pre_close', 'preclose', 'yesterday_close']));
  let pct = num(pick(row, ['change_pct', 'pct_change', 'change_percent']));
  if (pct == null && price != null && preClose) pct = ((price - preClose) / preClose) * 100;
  return {
    code: code6(pick(row, ['code', 'symbol', 'instrument_id', 'stock_code']) ?? ''),
    name: String(pick(row, ['name', 'stock_name']) ?? ''),
    price,
    preClose,
    open: num(pick(row, ['open', 'open_price'])),
    high: num(pick(row, ['high'])),
    low: num(pick(row, ['low'])),
    change: num(pick(row, ['change', 'change_value'])) ?? (price != null && preClose != null ? price - preClose : null),
    changePct: pct,
    volume: num(pick(row, ['volume', 'vol'])),
    amount: num(pick(row, ['amount', 'total_amount'])),
    turnover: num(pick(row, ['turnover', 'turnover_rate'])),
    time: String(pick(row, ['time', 'trade_time', 'update_time', 'datetime']) ?? '')
  };
}

/** 归一化特色指标卡片行 */
export function normalizeFeature(row) {
  return {
    code: code6(pick(row, ['code', 'symbol', 'instrument_id']) ?? ''),
    name: String(pick(row, ['name', 'stock_name']) ?? ''),
    auctionYesterdayRatio: num(pick(row, ['auction_prev_volume_ratio', 'auction_yesterday_ratio', 'auction_ratio'])),
    openVolumeRatio: num(pick(row, ['open_volume_ratio', 'open_vol_ratio'])),
    openTurnover: num(pick(row, ['open_turnover_z', 'open_turnover', 'open_turnover_rate'])),
    openGrab: num(pick(row, ['opening_rush', 'open_grab'])),
    freeFloatMv: num(pick(row, ['free_float_market_value', 'free_float_mv', 'free_float_value'])),
    updated: String(pick(row, ['stats_date', 'updated', 'update_time', 'datetime']) ?? '')
  };
}

/** 归一化连板天梯行 */
export function normalizeLadder(row) {
  return {
    code: code6(pick(row, ['symbol', 'code', 'instrument_id']) ?? ''),
    name: String(pick(row, ['name', 'stock_name']) ?? ''),
    seq: num(pick(row, ['ladder_level', 'seq', 'limit_seq', 'continuous_limit']) ?? 1),
    theme: String(pick(row, ['primary_theme', 'theme', 'concept', 'hot_concept']) ?? ''),
    lastLimitTime: String(pick(row, ['last_limit_time', 'limit_time', 'final_limit_time']) ?? ''),
    turnover: num(pick(row, ['turnover', 'turnover_rate'])),
    pct: num(pick(row, ['change_pct', 'pct_change']))
  };
}

/** 归一化题材强度行 */
export function normalizeTheme(row) {
  return {
    theme: String(pick(row, ['topic_name', 'theme', 'concept', 'name']) ?? ''),
    limitCount: num(pick(row, ['limit_up_count', 'limit_count', 'zt_count']) ?? 0),
    totalCount: num(pick(row, ['lianban_stock_count', 'total_count', 'stock_count']) ?? 0),
    strength: num(pick(row, ['theme_strength_score', 'strength', 'score']) ?? 0),
    leader: String(pick(row, ['leader_name', 'leader', 'dragon']) ?? ''),
    leaderCode: code6(pick(row, ['leader_instrument_id', 'leader_code']) ?? ''),
    pct: num(pick(row, ['change_pct', 'pct_change', 'avg_change_pct']))
  };
}
