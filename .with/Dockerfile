# 买卖时机分析面板 — 静态面板 + Python 同源代理
# 纯静态前端（index.html + js/css），由 server.py 托管并将 /v1/* 反代至 AxData 后端。

FROM python:3.11-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=Asia/Shanghai \
    PANEL_HOST=0.0.0.0 \
    PANEL_PORT=8000

WORKDIR /app

# 生产阶段：仅标准库依赖（ThreadingHTTPServer），无需 pip 安装
FROM base AS runner

# 创建非 root 用户
RUN useradd -m -u 1001 paneluser

# 复制项目文件（静态资源 + 代理服务器）
COPY --chown=paneluser:paneluser server.py index.html README.md ./
COPY --chown=paneluser:paneluser css ./css
COPY --chown=paneluser:paneluser js ./js

USER paneluser

EXPOSE 8000

# AxData 后端地址可通过构建参数/运行时环境变量覆盖
ENV AXDATA_API=http://127.0.0.1:8666 \
    API_TIMEOUT=15

CMD ["python3", "server.py"]
