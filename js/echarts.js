/**
 * echarts.js — ECharts CDN 按需引入（ESModule，禁止全量引入）
 * 只加载 K 线面板所需模块：K线/柱/折线图 + 网格/提示框/图例/缩放/标注组件 + Canvas 渲染器
 *
 * 注意：echarts npm 源码内部会裸导入 zrender/lib/* 与 tslib，
 * 这些裸模块名由 index.html 中的 <script type="importmap"> 解析，
 * 删除该 import map 会导致 "Module name does not resolve to a valid URL" 报错。
 */

import * as echarts from 'https://cdn.jsdelivr.net/npm/echarts@5.5.1/core.js';
import { CandlestickChart, BarChart, LineChart } from 'https://cdn.jsdelivr.net/npm/echarts@5.5.1/charts.js';
import {
  GridComponent, TooltipComponent, LegendComponent,
  DataZoomComponent, MarkPointComponent, AxisPointerComponent
} from 'https://cdn.jsdelivr.net/npm/echarts@5.5.1/components.js';
import { CanvasRenderer } from 'https://cdn.jsdelivr.net/npm/echarts@5.5.1/renderers.js';

echarts.use([
  CandlestickChart, BarChart, LineChart,
  GridComponent, TooltipComponent, LegendComponent,
  DataZoomComponent, MarkPointComponent, AxisPointerComponent,
  CanvasRenderer
]);

export default echarts;
export { echarts };
