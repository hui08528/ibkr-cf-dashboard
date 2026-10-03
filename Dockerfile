# IBKR Dashboard - 后端服务镜像
# 用法：docker build -t ibkr-dashboard .
# 生产环境建议通过 docker-compose 启动（env_file 注入密钥，避免把 .env 打进镜像）

FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用层缓存，源码改动时不重装）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 拷贝源码
COPY server.js ./
COPY functions ./functions
COPY public ./public

ENV NODE_ENV=production
# 容器内监听 0.0.0.0，暴露与否由 compose 的 ports 绑定 127.0.0.1 控制
ENV HOST=0.0.0.0
EXPOSE 3000

CMD ["node", "server.js"]
