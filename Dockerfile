# IBKR Dashboard - 后端服务镜像
# 用法：docker build -t ibkr-dashboard .
# 生产环境建议通过 docker-compose 启动（env_file 注入密钥，避免把 .env 打进镜像）
# 注意：用 bookworm-slim（glibc）而非 alpine —— longbridge 原生包只发布 glibc 变体，
#       alpine/musl 会加载失败并静默降级到 Alpha Vantage。
FROM node:current-slim

WORKDIR /app

# 先装依赖（利用层缓存，源码改动时不重装）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 修复 npm optional dependencies bug (npm/cli#4828)：
# longbridge 的原生平台包被安装在嵌套 node_modules 中，
# 需要提升到顶层 node_modules 才能被 require() 正确解析。
RUN cp -r node_modules/longbridge/node_modules/* node_modules/ 2>/dev/null || true

# 拷贝源码
COPY server.js ./
COPY functions ./functions
COPY public ./public

ENV NODE_ENV=production
# 容器内监听 0.0.0.0，暴露与否由 compose 的 ports 绑定 127.0.0.1 控制
ENV HOST=0.0.0.0
EXPOSE 3000

CMD ["node", "server.js"]
