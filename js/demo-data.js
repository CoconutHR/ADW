/**
 * demo-data.js — 演示数据模式
 * AxData 不可达时以内置模拟数据驱动完整界面（K线、信号、评分）。
 * 使用股票代码做随机种子，保证同一股票每次生成相同数据。
 */

/** 简单可复现 PRNG（mulberry32） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 将代码字符串转为数字种子 */
function seedOf(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 生成 N 个交易日的日期序列（跳过周末），从结束日往前推 */
function genDates(n, endDate = new Date('2026-09-11')) {
  const dates = [];
  const d = new Date(endDate);
  while (dates.length < n) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      dates.unshift(d.toISOString().slice(0, 10).replace(/-/g, ''));
    }
    d.setDate(d.getDate() - 1);
  }
  return dates;
}

/** 生成 K 线数据：带趋势段 + 随机波动 + 量能相关 */
function genKlines(code, n = 260, style = 'daily') {
  const rnd = mulberry32(seedOf(code + ':' + style));
  const dates = genDates(Math.ceil(n * 1.5)).slice(-n);

  // 基础价格：用代码哈希映射到 8~80 元区间
  const basePrice = 8 + (seedOf(code) % 7200) / 100; // 8 ~ 80
  const rows = [];
  let price = basePrice;
  let phase = 0; // 市场阶段轮换：0震荡 1上升 2回调
  let phaseLeft = 20 + Math.floor(rnd() * 30);

  for (let i = 0; i < n; i++) {
    if (--phaseLeft <= 0) {
      phase = (phase + 1 + (rnd() < 0.5 ? 0 : 1)) % 3;
      phaseLeft = 15 + Math.floor(rnd() * 35);
    }
    const drift = phase === 1 ? 0.004 : phase === 2 ? -0.003 : 0;
    const vol = 0.012 + rnd() * 0.02;

    const change = drift + (rnd() - 0.5) * 2 * vol;
    const open = price;
    const close = Math.max(1, open * (1 + change));
    const high = Math.max(open, close) * (1 + rnd() * vol * 0.6);
    const low = Math.min(open, close) * (1 - rnd() * vol * 0.6);

    // 成交量：与涨跌幅正相关 + 随机
    const volBase = 80000 + (seedOf(code) % 300000);
    const volume = Math.round(volBase * (1 + Math.abs(change) * 25) * (0.6 + rnd() * 0.9));
    const amount = Math.round(volume * (open + close) / 2);

    rows.push({
      code,
      date: dates[i],
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume,
      amount,
      turnover: +(volume / (5000 + (seedOf(code) % 40000)) * 100).toFixed(2)
    });
    price = close;
  }
  return rows;
}

/** 股票名称生成（演示用） */
const DEMO_NAMES = {};
function demoName(code) {
  if (DEMO_NAMES[code]) return DEMO_NAMES[code];
  const prefixes = ['华创', '东方', '天启', '岭南', '瑞和', '新能', '恒瑞', '中科', '云图', '明德', '拓维', '蓝海'];
  const suffixes = ['科技', '智造', '电子', '生物', '能源', '材料', '通信', '环保', '精密', '股份'];
  const rnd = mulberry32(seedOf('name' + code));
  const name = prefixes[Math.floor(rnd() * prefixes.length)] + suffixes[Math.floor(rnd() * suffixes.length)];
  DEMO_NAMES[code] = name;
  return name;
}

/** 实时快照 */
function genSnapshot(code) {
  const klines = genKlines(code, 30);
  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];
  const pct = ((last.close - prev.close) / prev.close) * 100;
  return [{
    code,
    name: demoName(code),
    price: last.close,
    pre_close: prev.close,
    open: last.open,
    high: last.high,
    low: last.low,
    change: +(last.close - prev.close).toFixed(2),
    change_pct: +pct.toFixed(2),
    volume: last.volume,
    amount: last.amount,
    turnover: last.turnover,
    time: '15:00:00'
  }];
}

/** 特色短线指标（竞价昨比、开盘量比、开盘换手Z等，字段与 stock_shortline_indicators_tdx 对齐） */
function genFeature(code) {
  const rnd = mulberry32(seedOf('feat' + code));
  return [{
    code,
    symbol: code,
    instrument_id: `${code}.SZ`,
    name: demoName(code),
    stats_date: '2026-09-11',
    auction_prev_volume_ratio: +(0.5 + rnd() * 4).toFixed(2),   // 竞价昨比
    open_volume_ratio: +(0.5 + rnd() * 3).toFixed(2),           // 开盘量比
    open_turnover_z: +(0.05 + rnd() * 2.5).toFixed(2),          // 开盘换手Z %
    opening_rush: +(rnd() * 1).toFixed(2),                      // 开盘抢筹 %
    free_float_market_value: Math.round((10 + rnd() * 300) * 1e8), // 流通市值Z(元)
  }];
}

/** 连板天梯（市场级） */
function genLadder() {
  const rnd = mulberry32(20260911);
  const themes = ['人工智能', '算力', '机器人', '低空经济', '半导体', '新能源', '军工', '医药', '消费电子', '信创'];
  const rows = [];
  let seq = 8;
  let count = 3;
  while (seq >= 2) {
    for (let i = 0; i < count && rows.length < 30; i++) {
      const code = String(600000 + Math.floor(rnd() * 300000)).padStart(6, '0');
      rows.push({
        code,
        symbol: code,
        instrument_id: `${code}.SH`,
        name: demoName(code + 'L'),
        ladder_level: seq,                              // 连板高度
        limit_board_text: `${seq}连板`,
        primary_theme: themes[Math.floor(rnd() * themes.length)],
        last_limit_time: `09:${25 + Math.floor(rnd() * 30)}:00`,
        turnover: +(1 + rnd() * 20).toFixed(2)
      });
    }
    seq--;
    count = Math.min(8, count + 2);
  }
  return rows;
}

/** 题材强度 */
function genThemeStrength() {
  const rnd = mulberry32(20260912);
  const themes = ['人工智能', '算力', '机器人', '低空经济', '半导体', '光伏', '固态电池', '汽车', '军工', '医药', '白酒', '信创', '数据要素', '氢能'];
  return themes.map(t => {
    const limitCount = Math.floor(rnd() * 20);
    const leaderCode = String(300000 + Math.floor(rnd() * 200000)).padStart(6, '0');
    return {
      topic_name: t,
      limit_up_count: limitCount,
      lianban_stock_count: Math.floor(rnd() * 8),
      first_board_count: Math.max(0, limitCount - Math.floor(rnd() * 8)),
      theme_strength_score: +(rnd() * 100).toFixed(1),
      leader_name: demoName('L' + t),
      leader_instrument_id: `${leaderCode}.SZ`,
      change_pct: +((rnd() - 0.4) * 6).toFixed(2)
    };
  }).sort((a, b) => b.theme_strength_score - a.theme_strength_score);
}

/**
 * 演示数据统一入口。
 * @param {string} api 接口名
 * @param {object} params 请求参数
 */
export function getDemoData(api, params = {}) {
  const code = params.code || params.symbol || '600519';
  switch (api) {
    case 'stock_kline_daily_tdx':
      return genKlines(code, 260, 'daily');
    case 'stock_kline_weekly_tdx':
      return genKlines(code, 120, 'weekly');
    case 'stock_kline_minute_tdx':
      return genKlines(code, 240, 'minute');
    case 'stock_realtime_snapshot_tdx':
      return genSnapshot(code);
    case 'stock_shortline_indicators_tdx':
      return genFeature(code);
    case 'stock_limit_ladder_tdx':
      return genLadder();
    case 'stock_theme_strength_rank_tdx':
      return genThemeStrength();
    default:
      return [];
  }
}

/** 演示模式的默认自选股 */
export const DEMO_WATCHLIST = [
  { code: '600519', name: '贵州茅台' },
  { code: '000858', name: '五粮液' },
  { code: '601318', name: '中国平安' },
  { code: '300750', name: '宁德时代' },
  { code: '002594', name: '比亚迪' },
  { code: '600036', name: '招商银行' }
];
