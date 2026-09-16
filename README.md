# AxData 买卖时机分析面板

一个基于 [AxData](https://github.com/electkismet/AxData) 量化数据库的**纯前端**买卖时机分析与规划面板。通过浏览器直连本地已部署的 AxData HTTP API，提供个股行情可视化、技术信号识别、多维度时机评分、短线特色指标、自选股批量扫描与历史信号回验等能力。

> 面板仅提供数据分析和框架性建议，不接入任何下单/交易通道；仅供个人研究使用。

## 功能特性

- **个股分析**：日/周/分钟 K 线主图 + 成交量副图，十字光标 OHLC 明细，MA/MACD/RSI/KDJ/BOLL 指标叠加，实时快照同屏展示
- **信号引擎**：MACD 金叉死叉、RSI 超买超卖、KDJ 金叉死叉、均线多空排列、量价背离等经典形态自动识别，多空冲突信号如实并列展示
- **五维时机评分**：趋势、动量、量能、波动率、位置五个维度打分，输出偏多/中性/偏空三态结论与参考价位，评分规则完全可解释
- **AxData 特色指标**：竞价昨比、开盘量比、开盘换手、自由流通市值、连板天梯、题材强度等短线指标集成，并纳入综合评分
- **名称目录**：启动时后台拉取全市场代码-名称表（`stock_codes_tdx`，约 5500 条）并缓存 24 小时。AxData 的行情接口不返回证券名称，补全后界面统一显示「名称 代码」，且自选与查询框均支持**直接输入名称**（如「茅台」「五粮液」）
- **自选扫描**：自选股本地持久化，受限并发批量扫描（可取消、有进度），支持按评分/信号方向/涨跌幅排序筛选
- **历史回验**：信号触发后 N 日收益分布统计（胜率、平均/中位收益、最大单笔亏损等），附带样本量说明
- **优雅降级**：Provider 不可用、停牌空数据、服务超时等场景均有可读提示，不阻塞页面其他区域
- **演示模式**：AxData 不可达时可切换内置模拟数据驱动完整界面，便于功能预览与排查

A 股配色习惯：红涨绿跌。

## 技术栈

| 项目 | 说明 |
| --- | --- |
| 页面架构 | 无框架原生 JS（ESModule），Hash 路由，零构建、零打包 |
| UI 样式 | Tailwind CSS（CDN 引入）+ Remix Icon 图标库 |
| 图表 | ECharts 5 按需引入（import map 解析 `zrender`/`tslib` 依赖） |
| 数据源 | AxData HTTP API（`POST /v1/request/{接口名}`） |
| 持久化 | 浏览器 localStorage（配置、自选股、最近浏览） |

## 项目结构

```
.
├── index.html                    # 唯一入口页面（import map、Tailwind 配置、路由挂载点）
├── server.py                     # 本地同源服务器：托管面板 + 反代 /health、/v1/* 到 AxData（推荐启动方式）
├── css/
│   └── style.css                 # 全局补充样式（卡片、表单、滚动条等）
└── js/
    ├── main.js                   # 应用入口：注册路由、全局状态初始化
    ├── router.js                 # Hash 路由器
    ├── api.js                    # AxData 数据适配层（超时/可读错误/演示模式拦截）
    ├── store.js                  # localStorage 封装（配置/自选股）
    ├── normalize.js              # 数据规范化（字段映射、类型清洗）
    ├── names.js                  # 证券名称目录（代码↔名称、24h 缓存、按名称搜索、展示助手）
    ├── indicators.js             # 技术指标计算（MA/MACD/RSI/KDJ/BOLL）
    ├── signal.js                 # 信号识别引擎
    ├── scoring.js                # 五维评分与综合时机建议
    ├── scheduler.js              # 受限并发调度器（批量扫描用）
    ├── demo-data.js              # 演示模式内置模拟数据
    ├── echarts.js                # ECharts 按需引入封装
    ├── ui.js                     # Toast、连接状态等通用 UI
    ├── signal.test.js            # 信号引擎单元测试（浏览器控制台运行）
    ├── backtest-engine.js        # 历史回验统计引擎
    ├── backtest-engine.test.js   # 回验引擎单元测试（Node 运行）
    ├── components/               # 复用组件（K线图、评分面板、特色指标卡）
    └── views/                    # 五个页面视图（个股/扫描/市场/回验/配置）
```

## 部署教程

### 前置条件

1. 一台可运行浏览器的机器（桌面 Chrome/Edge 为佳）
2. 本地已部署 AxData 服务，且 HTTP API 正常监听（默认 `http://127.0.0.1:8666`，鉴权模式 `local open`，本机回环免 token）
3. AxData 已启用所需 Provider 插件（通达信 K 线、实时快照、特色指标等，按需开启）

### 方式一：同源代理启动（推荐，零依赖）

浏览器规定协议/域名/端口任一不同即跨域：面板（8080）与 AxData（8666）端口不同，而 AxData 自带 `CORSMiddleware` 且只放行白名单来源，跨域预检会被直接拒（响应体为 `Disallowed CORS origin`，AxData 日志可见 `OPTIONS /v1/request/... 400`），这正是「测试连接」报「网络错误或跨域限制」的原因。项目自带的 [server.py](server.py) 同时静态托管面板并把 `/health`、`/v1/*` 反向代理到 AxData，让两者同源，从根上规避 CORS，**无需修改 AxData 任何代码**：

```bash
# 仅需 Python 3.7+ 标准库，无需安装任何依赖
python3 server.py

# 可选环境变量：
# AXDATA_API=http://127.0.0.1:8666   AxData 后端地址
# PANEL_HOST=127.0.0.1               面板监听地址（0.0.0.0 可局域网访问）
# PANEL_PORT=8080                    面板监听端口
```

启动后：

1. 浏览器打开 `http://127.0.0.1:8080`
2. 面板启动时会自动探测可用地址并选中同源代理（`http://127.0.0.1:8080`），右上角显示「已连接」即可开始使用，**无需手工改地址**
3. 如需指定地址，进入「设置」页填写后点「测试连接」；也可点「自动检测」由面板重新探测

> 探测顺序：页面自身 origin（server.py 托管时即同源代理）→ `http://127.0.0.1:8080` → `http://127.0.0.1:8666`。
> 一旦被 AxData 的 CORS 白名单拒绝，面板会自动切换到可用地址并在控制台记录一条 warning。

### 方式二：AxData 服务端放行 CORS

AxData 基于 FastAPI，CORS 需通过其 CORSMiddleware 配置（注意：**uvicorn 没有 `--cors-allow-all` 之类的启动参数**，网上部分教程有误）。若不想改面板启动方式，可在 AxData 的 `apps/api/main.py` 中添加：

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8080"],  # 面板所在来源
    allow_methods=["*"],
    allow_headers=["*"],
)
```

改完后用原命令重启 AxData 即可，面板服务地址保持 `http://127.0.0.1:8666` 不变。

### 方式三：Nginx 反向代理（同域部署）

适合已有 Nginx 的场景，效果与方式一相同：

```nginx
server {
    listen 8080;

    # 面板静态文件
    root /path/to/axdata-trade-panel;
    index index.html;

    # AxData API 反代
    location /v1/ {
        proxy_pass http://127.0.0.1:8666/v1/;
    }
    location /health {
        proxy_pass http://127.0.0.1:8666/health;
    }
}
```

随后在面板「设置」页将服务地址改为 `http://127.0.0.1:8080`，请求路径模板保持 `/v1/request/{api}` 不变。

> 注意：直接双击 `index.html`（file:// 协议）在部分浏览器下受 ESModule 与 CORS 限制，推荐始终通过上述任一服务器访问。

### 连接排错清单

1. **先看 AxData 日志**：若出现 `OPTIONS /v1/... 400`（响应体 `Disallowed CORS origin`），即跨域预检被 AxData 的 CORS 白名单拒绝，使用方式一/二/三任一解决。面板默认会自动切换到可用地址，因此正常情况下不会命中此项；若右上角仍显示「连接失败」，说明候选地址全部不可达，请按下面逐条排查
2. **浏览器旧缓存**：若 AxData 日志出现 `stock_spot_feature_tdx`（旧版接口名，已废弃）或 K 线请求持续 400，说明浏览器在跑修复前的旧 JS。实测确认旧版请求体携带非法 `fields`（如 `date`，真实字段名为 `trade_time`），会被 AxData 严格校验拒绝（400 `SOURCE_REQUEST_VALIDATION_ERROR: Unknown field(s)`）。解决办法：强刷页面（`Cmd/Ctrl+Shift+R`）或清站点缓存；新版 server.py 已对静态文件下发 `Cache-Control: no-store`，且 `index.html` 资源引用带 `?v=` 版本号，重启 `python3 server.py` 后即可根治。可在「设置」页左上角或控制台启动日志核对版本（当前 `v1.2.0`）
3. **混合内容限制**：HTTPS 页面无法访问本机 HTTP API，请将面板下载到本地以 http:// 方式打开，或使用代理方案
4. **端口确认**：`lsof -iTCP:8666 -sTCP:LISTEN`（macOS）确认 AxData 已监听；`local open` 鉴权模式下仅允许本机回环访问
5. **演示模式**：以上均不可用时，在「设置」页打开「演示数据模式」，用内置模拟数据体验全部功能（页面顶部会持续标注）

## 配置说明

所有配置持久化于浏览器 localStorage，在「设置」页（`#/config`）修改：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| 服务地址（Base URL） | 自动探测 | 启动时按「页面 origin → `127.0.0.1:8080` → `127.0.0.1:8666`」顺序探测首个可用地址；在设置页手工保存后即以手工值为准，仅在失效时兜底切换。8667 为 AxData 自带控制台，面板不依赖 |
| 请求路径模板 | `/v1/request/{api}` | `{api}` 为接口名占位符（如 `stock_kline_daily_tdx`）；AxData 版本接口路径不同时可调整，无需改代码 |
| 请求超时 | 10 秒 | 3–60 秒可调 |
| 演示数据模式 | 关闭 | 开启后所有请求被拦截为内置模拟数据 |

面板依赖的 AxData 接口（在 `js/api.js` 的 `APIS` 注册表中维护）：

| 接口名 | 用途 | 关键参数 |
| --- | --- | --- |
| `stock_kline_daily_tdx` | 日K线（前复权） | `code`、`adjust: fixed_qfq`、`anchor_date: 当天`，返回全量历史，前端按需截取 |
| `stock_kline_weekly_tdx` | 周K线 | 同上 |
| `stock_kline_minute_tdx` | 分钟K线（默认 5m） | `code`、`period: 5m`、`adjust: none` |
| `stock_realtime_snapshot_tdx` | 实时快照 | `code` |
| `stock_shortline_indicators_tdx` | 短线指标（竞价昨比/开盘量比/开盘换手Z/开盘抢筹/流通市值Z） | `code` |
| `stock_limit_ladder_tdx` | 连板天梯 | `scope: all`（默认 main 仅主板） |
| `stock_theme_strength_rank_tdx` | 题材强度排行 | `scope: all` |
| `stock_codes_tdx` | 全市场代码-名称表 | 无必填参数，约 5500 条，用于名称补全与按名称搜索 |

对应 Provider 未安装时该板块展示「该数据源不可用」占位，不影响其他功能。接口契约以 AxData 文档站（electkismet.github.io/AxData/interfaces）为准，多余参数会被严格校验拒绝（400）。

> **为什么用 `fixed_qfq` 而不是 `qfq`**：上游 TDX 行情服务器的 `qfq` 采用「减法式」调整（从原始价逐笔扣减累计每股现金分红），而非标准乘法式复权因子，导致长历史、高分红个股的早期 K 线价格为负——实测 600519 有 3529/6005 根日 K 为负（最负 -314.87），抽检 6 只个股中 5 只受影响，且正值区间同样失真（2016-09-30 返回 6.25，标准值 241.33）。`fixed_qfq` 走的是正确的乘法式实现，实测与用 XDXR 事件独立复算的标准前复权值完全一致。详见 `js/api.js` 中 `klineAdjustParams()` 的注释。

## 运行测试

```bash
# 回验引擎测试（Node 环境，文件头注释指定的运行方式）
node --experimental-vm-modules js/backtest-engine.test.js

# 信号引擎测试（浏览器控制台运行）
# 打开面板页面后在 DevTools Console 中：
# import('./js/signal.test.js').then(m => m.runSignalTests());
```

## 常见问题

**Q：页面打开后右上角显示「连接失败」？**
面板自带地址自动探测，正常情况下不会命中此项——若仍失败，说明候选地址全部不可达：先确认 AxData 已启动（`curl http://127.0.0.1:8666/health`），再用 `python3 server.py` 同源启动面板（同时规避 CORS），然后检查是否从 https 页面访问本机 http 服务（混合内容限制），详见「连接排错清单」。

**Q：控制台出现 `已自动选用可用服务地址` 或 `原服务地址 ... 不可用，已自动切换`？**
这是预期行为。说明配置里的 8666 被 AxData 的 CORS 白名单拒绝，面板已自动改走同源代理，无需处理；若想固定地址，在「设置」页保存一次即可（此后以手工值为准）。

**Q：K 线图为空或提示「可能未采集或代码不存在」？**
多为该股票数据未在 AxData 中采集，或对应 Provider 未启用。可先在 AxData 控制台确认数据存在，再回到面板重试。

**Q：评分只显示了部分维度？**
这是预期行为。停牌、字段缺失或 Provider 不可用时面板会降级为部分维度评分，并明确标注数据缺口。

**Q：能直接下单交易吗？**
不能。面板是纯分析工具，不含任何交易通道，这也是它的技术边界之一。

## 免责声明

数据来源：AxData · 仅供个人研究使用。所有信号、评分与参考价位均由历史数据推算，不构成任何投资建议。
