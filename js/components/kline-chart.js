/**
 * components/kline-chart.js — K线图表组件
 * ECharts 封装：主图 K线 + MA/BOLL 叠加、副图成交量、MACD/KDJ 副图、
 * 信号标注、十字光标明细、指标开关、周期外部刷新。
 * A股配色：红涨绿跌。
 */

import echarts from '../echarts.js';

const UP = '#ef4444';    // 红涨
const DOWN = '#22c55e';  // 绿跌

/** 指标展示配置（颜色/名称/层级） */
export const OVERLAY_DEFS = {
  ma: { label: 'MA', color: null },
  boll: { label: 'BOLL', color: null },
  macd: { label: 'MACD', color: null },
  kdj: { label: 'KDJ', color: null }
};

/**
 * 创建 K 线图表实例。
 * @param {HTMLElement} el 容器
 * @param {object} state { klines, indicators, signals, overlays: {ma,boll,macd,kdj} }
 * @returns {object} 控制器 { chart, update(state), resize, dispose, onSelectIndex }
 */
export function createKlineChart(el, state) {
  const chart = echarts.init(el);
  let hoverHandler = null;

  function update(next) {
    const { klines = [], indicators = null, signals = [], overlays = {} } = next || {};
    if (!klines.length) {
      chart.clear();
      return;
    }
    const dates = klines.map(k => k.date);
    const upDown = klines.map((k, i) => (i === 0 ? 1 : k.close >= klines[i - 1].close ? 1 : -1));

    // ---- 主图 series ----
    const mainSeries = [{
      name: 'K线',
      type: 'candlestick',
      data: klines.map(k => [k.open, k.close, k.low, k.high]),
      xAxisIndex: 0, yAxisIndex: 0,
      itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN },
      emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(79,70,229,.4)' } }
    }];

    // MA 叠加
    if (overlays.ma && indicators) {
      const maDefs = [
        { key: 'ma5', n: 5, color: '#f59e0b' },
        { key: 'ma10', n: 10, color: '#6366f1' },
        { key: 'ma20', n: 20, color: '#38bdf8' },
        { key: 'ma60', n: 60, color: '#c084fc' }
      ];
      for (const d of maDefs) {
        const ind = indicators[d.key];
        if (!ind || ind.insufficient || !ind.values) continue;
        mainSeries.push({
          name: `MA${d.n}`, type: 'line', data: ind.values,
          showSymbol: false, smooth: false, xAxisIndex: 0, yAxisIndex: 0,
          lineStyle: { width: 1.2, color: d.color }, itemStyle: { color: d.color }, z: 3
        });
      }
    }

    // BOLL 叠加
    if (overlays.boll && indicators && indicators.boll && !indicators.boll.insufficient) {
      const { mid, upper, lower } = indicators.boll;
      mainSeries.push({
        name: 'BOLL中轨', type: 'line', data: mid, showSymbol: false, xAxisIndex: 0, yAxisIndex: 0,
        lineStyle: { width: 1, color: '#fbbf24', type: 'dashed' }, itemStyle: { color: '#fbbf24' }, z: 3
      }, {
        name: 'BOLL上轨', type: 'line', data: upper, showSymbol: false, xAxisIndex: 0, yAxisIndex: 0,
        lineStyle: { width: 1, color: '#94a3b8', type: 'dotted' }, itemStyle: { color: '#94a3b8' }, z: 3
      }, {
        name: 'BOLL下轨', type: 'line', data: lower, showSymbol: false, xAxisIndex: 0, yAxisIndex: 0,
        lineStyle: { width: 1, color: '#94a3b8', type: 'dotted' }, itemStyle: { color: '#94a3b8' }, z: 3
      });
    }

    // 信号标注（主图 markPoint，仅最近信号避免拥挤）
    const recentIdx = new Set(signals.map(s => s.index));
    if (signals.length) {
      const bullMarks = [], bearMarks = [];
      for (const s of signals) {
        const mk = { coord: [s.date, s.price], value: s.label, index: s.index };
        (s.direction === 'bullish' ? bullMarks : bearMarks).push(mk);
      }
      const kSeries = mainSeries[0];
      kSeries.markPoint = {
        symbol: 'triangle', symbolSize: 9, label: { show: false },
        data: [
          { symbolRotate: 0, itemStyle: { color: 'rgba(239,68,68,.95)' }, data: bullMarks },
          { symbolRotate: 180, itemStyle: { color: 'rgba(34,197,94,.95)' }, data: bearMarks }
        ].map(g => g.data.map(m => ({ ...m, itemStyle: g.itemStyle, symbolRotate: g.symbolRotate }))).flat()
      };
    } else {
      mainSeries[0].markPoint = { data: [] };
    }

    // ---- 副图 series ----
    const subSeries = [{
      name: '成交量',
      type: 'bar',
      data: klines.map((k, i) => ({ value: k.volume, itemStyle: { color: upDown[i] > 0 ? UP + 'b3' : DOWN + 'b3' } })),
      xAxisIndex: 1, yAxisIndex: 1
    }];

    const grids = [
      { left: '8%', right: '3%', top: '6%', height: '52%' },
      { left: '8%', right: '3%', top: '62%', height: '12%' }
    ];
    const xAxes = [0, 1].map(i => ({
      type: 'category', gridIndex: i, data: i === 0 ? dates : dates.slice(),
      boundaryGap: true, axisLine: { lineStyle: { color: '#334155' } },
      axisLabel: { show: i === 1, color: '#64748b', fontSize: 10 },
      axisTick: { show: false }, splitLine: { show: false }
    }));
    const yAxes = [
      { type: 'value', gridIndex: 0, scale: true, axisLabel: { color: '#64748b', fontSize: 10 }, splitLine: { lineStyle: { color: '#1e293b' } } },
      { type: 'value', gridIndex: 1, axisLabel: { color: '#64748b', fontSize: 10 }, splitLine: { show: false } }
    ];

    // MACD 副图
    if (overlays.macd && indicators && indicators.macd && !indicators.macd.insufficient) {
      const { dif, dea, macd } = indicators.macd;
      const gi = grids.length;
      grids.push({ left: '8%', right: '3%', top: `${76}%`, height: '18%' });
      xAxes.push({
        type: 'category', gridIndex: gi, data: dates, boundaryGap: true,
        axisLabel: { color: '#64748b', fontSize: 10 }, axisLine: { lineStyle: { color: '#334155' } }, axisTick: { show: false }
      });
      yAxes.push({ type: 'value', gridIndex: gi, axisLabel: { color: '#64748b', fontSize: 10 }, splitLine: { show: false } });
      subSeries.push(
        { name: 'DIF', type: 'line', data: dif, showSymbol: false, xAxisIndex: 2, yAxisIndex: 2, lineStyle: { width: 1, color: '#f59e0b' }, itemStyle: { color: '#f59e0b' } },
        { name: 'DEA', type: 'line', data: dea, showSymbol: false, xAxisIndex: 2, yAxisIndex: 2, lineStyle: { width: 1, color: '#6366f1' }, itemStyle: { color: '#6366f1' } },
        { name: 'MACD', type: 'bar', data: macd.map(v => v == null ? null : {
          value: v, itemStyle: { color: v >= 0 ? UP + 'cc' : DOWN + 'cc' }
        }), xAxisIndex: 2, yAxisIndex: 2 }
      );
    }

    // KDJ 副图
    if (overlays.kdj && indicators && indicators.kdj && !indicators.kdj.insufficient) {
      const gi = grids.length;
      const { k, d, j } = indicators.kdj;
      grids.push({ left: '8%', right: '3%', top: `${76}%`, height: '18%' });
      xAxes.push({
        type: 'category', gridIndex: gi, data: dates, boundaryGap: true,
        axisLabel: { color: '#64748b', fontSize: 10 }, axisLine: { lineStyle: { color: '#334155' } }, axisTick: { show: false }
      });
      yAxes.push({ type: 'value', gridIndex: gi, axisLabel: { color: '#64748b', fontSize: 10 }, splitLine: { show: false } });
      subSeries.push(
        { name: 'K', type: 'line', data: k, showSymbol: false, xAxisIndex: gi, yAxisIndex: gi, lineStyle: { width: 1, color: '#f59e0b' }, itemStyle: { color: '#f59e0b' } },
        { name: 'D', type: 'line', data: d, showSymbol: false, xAxisIndex: gi, yAxisIndex: gi, lineStyle: { width: 1, color: '#6366f1' }, itemStyle: { color: '#6366f1' } },
        { name: 'J', type: 'line', data: j, showSymbol: false, xAxisIndex: gi, yAxisIndex: gi, lineStyle: { width: 1, color: '#38bdf8' }, itemStyle: { color: '#38bdf8' } }
      );
    }

    chart.setOption({
      animation: false,
      backgroundColor: 'transparent',
      axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: '#334155' } },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', crossStyle: { color: '#64748b' } },
        backgroundColor: 'rgba(15,23,42,.95)',
        borderColor: '#334155',
        textStyle: { color: '#e2e8f0', fontSize: 12 },
        formatter: (params) => {
          if (!Array.isArray(params) || !params.length) return '';
          const i = params[0].dataIndex;
          const k = klines[i];
          const prev = i > 0 ? klines[i - 1].close : k.open;
          const pct = ((k.close - prev) / prev * 100).toFixed(2);
          const color = k.close >= prev ? UP : DOWN;
          return `<div style="min-width:200px">
            <div style="color:#94a3b8;margin-bottom:4px">${k.date}</div>
            <div>开 <span style="color:${color}" class="tabular">${k.open?.toFixed(2) ?? '--'}</span>
                高 <span style="color:${UP}">${k.high?.toFixed(2) ?? '--'}</span></div>
            <div>低 <span style="color:${DOWN}">${k.low?.toFixed(2) ?? '--'}</span>
                收 <span style="color:${color};font-weight:600">${k.close?.toFixed(2) ?? '--'}</span></div>
            <div>涨跌 <span style="color:${color}">${pct > 0 ? '+' : ''}${pct}%</span>
                量 <span style="color:#e2e8f0">${fmtVol(k.volume)}</span></div>
            ${signalsByIndex(i).length ? `<div style="margin-top:4px;padding-top:4px;border-top:1px dashed #334155">${signalsByIndex(i).map(s =>
              `<div style="color:${s.direction === 'bullish' ? UP : DOWN};font-size:11px">◆ ${s.label}：${s.reason}</div>`).join('')}</div>` : ''}
          </div>`;
        }
      },
      grid: grids,
      xAxis: xAxes,
      yAxis: yAxes,
      dataZoom: [
        { type: 'inside', xAxisIndex: xAxes.map((_, i) => i), start: Math.max(0, 100 - (120 / klines.length) * 100), end: 100 },
        { type: 'slider', xAxisIndex: 0, bottom: 0, height: 16, borderColor: '#1e293b', backgroundColor: '#0f172a', fillerColor: 'rgba(79,70,229,.15)', handleStyle: { color: '#4f46e5' }, textStyle: { color: '#64748b', fontSize: 10 } }
      ],
      series: [...mainSeries, ...subSeries]
    }, { notMerge: true });
  }

  function signalsByIndex(i) {
    return (state?.signals || []).filter(s => s.index === i);
  }

  function fmtVol(v) {
    if (!Number.isFinite(Number(v))) return '--';
    const n = Number(v);
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(2) + '万';
    return String(n);
  }

  update(state);

  return {
    chart,
    update(next) { state = next; update(next); },
    resize() { chart.resize(); },
    dispose() { chart.dispose(); },
    onHover(fn) { hoverHandler = fn; }
  };
}
