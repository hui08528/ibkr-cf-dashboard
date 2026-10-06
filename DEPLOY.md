# 部署指南：海外 VPS 自托管（Docker 多服务）

本方案把项目从 Cloudflare Pages 迁移为**海外 VPS 自托管**，直连源站、无 CDN，目标是在中国大陆可直接访问（参考已上线的 `nw.moneychen.com` 做法）。

**架构面向多后端服务**：Docker + docker-compose 编排，每个后端一个容器，宿主 nginx 按路径分流。以后加服务 = 加一个容器 + 加一段 nginx location，互不影响。

- 后端：`server.js`（Express）+ 复用 `functions/api/*.js` 三个 API（IBKR Flex / 财报 / 行情）
- 前端：`public/` 静态文件，相对路径 fetch 同域 API，**无需改动**
- 鉴权：nginx Basic Auth（整站保护，零前端改动）

---

## 一、服务器选购（国内直连、免备案）

**原则**：只能选**境外 / 港澳台**服务器（大陆服务器需 ICP 备案）；线路质量比 CPU/内存重要。

**配置**：本仪表板本身 1C1G 就够，但你说过**后面还要加后端服务**（可能带数据库/缓存），所以：
- **最低 2C2G**，**推荐 2C4G**（留出跑数据库、缓存、额外 API 服务的余量）
- 磁盘 40GB SSD+ 起步

**首选地区**（按大陆延迟/线路排序）：
| 地区 | 说明 |
|---|---|
| 香港 | 延迟最低，BGP 直连，优先推荐 |
| 日本 | SoftBank / IIJ 线路，联通、移动友好 |
| 新加坡 | Singtel 线路 |

**可选服务商（大致价格）**：
- 腾讯云轻量应用服务器 · 香港 2C4G —— 约 ¥34-60/月，需实名，大陆直连尚可
- 阿里云国际站轻量 · 香港/新加坡 —— 约 $3-5/月
- Vultr · 东京（选 SoftBank 机房）/新加坡 —— $6-12/月，按小时计费
- DigitalOcean · 新加坡 —— $6/月起
- Linode/Akamai · 东京（IIJ 线路，移动友好）—— $5/月（2G 档）
- 搬瓦工 BandwagonHost · CN2 GIA 精品线路 —— 约 $50/年起，直连质量最好但贵
- Contabo · 新加坡/日本大阪 —— €4.5/月起步，便宜，但高峰期网络一般；**不要选欧洲/美国机房**（延迟 200ms+）

**建议**：多服务场景下优先**香港或日本 2C2G/2C4G**；看重访问质量再上 CN2 GIA。

> 部署前先在 VPS 上确认出网正常：
> `curl -I https://www.alphavantage.co && curl -I https://ndcdyn.interactivebrokers.com`
> （个别廉价机房会屏蔽海外金融 API）

---

## 二、本地先跑通（Windows/Mac 开发机）

```bash
npm install
cp .env.example .env        # 先只留 PORT/HOST/NODE_ENV，密钥可后填
npm run check               # 语法检查全绿
npm run dev                 # 另开终端验证：
```

```bash
curl -i http://127.0.0.1:3000/                          # 200 text/html
curl -i http://127.0.0.1:3000/app.js                    # 200
curl -i http://127.0.0.1:3000/api/portfolio             # 503 JSON（未配置 token 属预期）
curl -i "http://127.0.0.1:3000/api/earnings?symbols=QQQ" # 503 JSON
curl -i http://127.0.0.1:3000/functions/api/portfolio.js # 404（源码未被静态暴露）
curl -i http://127.0.0.1:3000/healthz                   # {"ok":true}
```

填好真实密钥到 `.env` 后重测，3 个 API 应返回真实数据，二次请求带 `"cached":true`。浏览器打开 `http://127.0.0.1:3000/` 确认仪表板正常。

---

## 三、VPS 上部署（Docker 方案，推荐）

### 1. 初始化系统

```bash
apt update && apt upgrade -y
apt install -y nginx apache2-utils certbot python3-certbot-nginx ufw
ufw allow 80,443 && ufw enable
```

### 2. 安装 Docker + compose 插件

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
docker compose version    # v2，确认 OK
```

> 不用再单独装 Node —— 后端跑在容器里，Node 环境由镜像提供。

### 3. 部署代码

```bash
mkdir -p /opt/ibkr-cf-dashboard
# 方式 A：git clone
git clone https://github.com/hui08528/ibkr-cf-dashboard.git /opt/ibkr-cf-dashboard
# 方式 B：从本地上传（排除 node_modules/.git/.env）
# rsync -av --exclude node_modules --exclude .git --exclude .env ./ deploy@server:/opt/ibkr-cf-dashboard/

cd /opt/ibkr-cf-dashboard
cp .env.example .env
vim .env                    # 填 IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID / ALPHA_VANTAGE_API_KEY
chmod 600 .env
```

### 3.5 长桥 token（可选，启用 `/api/market` 长桥行情时）

容器内没有本机 `~/.longbridge` token 缓存，需把**已授权开发机**上的 token 文件 base64 后填进 `.env`，
容器首次请求时自动恢复到 `~/.longbridge/openapi/tokens/<client_id>`：

```bash
# 在已授权的开发机（本机）执行，输出一串 base64：
client_id=$(grep '^LONGBRIDGE_OAUTH_CLIENT_ID=' .env | cut -d= -f2)
base64 -w0 "$HOME/.longbridge/openapi/tokens/$client_id"    # macOS / Linux / Git Bash
# Windows PowerShell： [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\.longbridge\openapi\tokens\$client_id"))
```

在 VPS 的 `.env` 里新增：

```
LONGBRIDGE_OAUTH_TOKEN_CACHE_B64=<上面输出的 base64 字符串>
```

> 不配长桥也能跑：`/api/market` 自动降级回 Alpha Vantage（此时需填 `ALPHA_VANTAGE_API_KEY`）。
> token 约 90 天过期并自动刷新；容器重建后首次请求会从 B64 自动恢复，无需人工干预。

### 4. 构建并启动

```bash
docker compose config                 # 校验编排文件语法（重要，先跑）
docker compose up -d --build
docker compose ps                     # dashboard 应为 running + healthy
docker compose logs -f dashboard      # 看日志
```

验证容器内健康检查：`curl 127.0.0.1:3000/healthz` → `{"ok":true}`。

### 5. 配置 nginx

```bash
cp deploy/nginx.conf /etc/nginx/sites-available/ibkr-dashboard
# 编辑 server_name 改成你的域名
ln -s /etc/nginx/sites-available/ibkr-dashboard /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
# 此时 http://域名 已可用
```

### 6. 开启 Basic Auth（强烈建议，保护整站与所有 API）

```bash
htpasswd -c /etc/nginx/.htpasswd dashboard   # 输入强密码（可用 openssl rand -base64 24 生成）
```
去掉 `deploy/nginx.conf` 里 `auth_basic` 两行注释 → `nginx -t && systemctl reload nginx`。
浏览器首次访问弹一次登录框后，同源 API fetch 会自动带凭据，无需改前端。

### 7. 签发 HTTPS

```bash
certbot --nginx -d 你的域名
```
自动配 443 与 80→443 跳转。

---

## 四、以后怎么加新后端服务

1. 在 `docker-compose.yml` 追加一个 service（镜像或本地 build，绑定 `127.0.0.1:新端口:容器端口`，示例已在文件里注释）。
2. 在 `deploy/nginx.conf` 加一个 `location`，`proxy_pass` 到那个新端口。
3. `docker compose up -d --build` + `nginx -t && systemctl reload nginx`。

需要数据库/缓存时直接加官方镜像（postgres/redis/mysql）并挂卷，密钥继续走 `.env`（在 `docker-compose.yml` 里用 `${VAR}` 引用，`.env` 中新增变量）。

---

## 验证清单

```bash
curl -u dashboard:密码 https://你的域名/api/portfolio     # 真实持仓 JSON
curl -u dashboard:密码 https://你的域名/api/market        # QQQ 行情
curl -u dashboard:密码 https://你的域名/healthz           # {"ok":true}（不要求凭据）
curl -I https://你的域名/app.js                          # Cache-Control 无 immutable
```
浏览器访问 `https://你的域名/`：弹一次登录框后全站可用，图表与数据正常。

> 老访客如果之前用过旧版（immutable 缓存），需硬刷新一次（`Ctrl+Shift+R`），之后不再复发。

---

## 排障

| 现象 | 处理 |
| --- | --- |
| `docker compose config` 报错 | 编辑 YAML 缩进；密钥未定义先占位 |
| 容器 `unhealthy` / `502` | `docker compose logs dashboard`；`healthz` 是否 200 |
| `401` | Basic Auth 凭据错误，`htpasswd` 重新生成 |
| `/api/portfolio` 很慢 | IBKR 两步 + 最多 4 次重试，10s+ 正常；nginx `proxy_read_timeout 120s` 已放宽 |
| `/api/market` 报额度 | Alpha Vantage 免费 key 每天 25 次，`MARKET_CACHE_SECONDS` 调大 |
| 更新代码 | `git pull && docker compose build dashboard && docker compose up -d` |
| 证书过期 | certbot 自带定时续期；手动 `certbot renew --dry-run` 验证 |
| 磁盘被 Docker 日志/镜像撑满 | `docker system prune -f`（清无用镜像缓存）；日志限制见 `docker-compose.yml` 的 logging 配置 |

---

## 附录 A：不用 Docker 的轻量方式（PM2 / systemd）

如果不想引入 Docker，也可以直接跑 Node 进程（`node server.js`），二选一即可：

**PM2**（`ecosystem.config.cjs` 已备好）：
```bash
apt install -y nodejs   # 或用 nodesource 装 Node 20
npm i -g pm2 && pm2 install pm2-logrotate
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
pm2 logs ibkr-dashboard --lines 100
```

**systemd**（`deploy/ibkr-dashboard.service`）：
```bash
cp deploy/ibkr-dashboard.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now ibkr-dashboard
```

> 单服务够用；一旦开始加第二个服务，建议切到 Docker 方案。

---

## 环境变量一览

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | 否 | 监听地址，默认 `3000` / `127.0.0.1`（容器内为 `0.0.0.0`，由 compose 绑定宿主端口） |
| `IBKR_FLEX_TOKEN` | 是 | IBKR Client Portal Flex Web Service token |
| `IBKR_FLEX_QUERY_ID` | 是 | Flex Query 编号 |
| `IBKR_FLEX_CACHE_SECONDS` | 否 | 组合缓存秒数，默认 600 |
| `ALPHA_VANTAGE_API_KEY` | 否 | 财报日历 + QQQ 行情用 |
| `EARNINGS_CACHE_SECONDS` | 否 | 财报缓存秒数，默认 86400 |
| `MARKET_CACHE_SECONDS` | 否 | 行情缓存秒数，默认 300（配置长桥后走实时行情，不耗 Alpha Vantage 额度） |
| `BENCHMARK_CACHE_SECONDS` | 否 | 基准行情缓存秒数，默认 86400（QQQ 日线，1 次/天） |
| `LONGBRIDGE_OAUTH_CLIENT_ID` | 否 | 长桥 OAuth client_id，`/api/market` 首选行情源（未配置时回退 Alpha Vantage） |
| `LONGBRIDGE_REGION` | 否 | 长桥接入区，国内填 `cn` |
| `LONGBRIDGE_OAUTH_TOKEN_CACHE_B64` | 否 | Docker/CI：本机 token 缓存 base64 后填入，容器启动自动恢复到 `~/.longbridge` |
| `DB_PASSWORD` 等 | 否 | 以后加数据库时在 `.env` 新增，compose 里 `${DB_PASSWORD}` 引用 |
