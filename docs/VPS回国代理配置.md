# VPS 回国代理配置（SSH 反向隧道）

> 场景：生产 VPS 在海外（东京），新浪/腾讯行情接口对海外 IP 受限无法直连。
> 通过 SSH 反向隧道借用**本地开发机的 Clash（大陆出口）**访问国内行情接口。
>
> 反向的另一条链路（本地开发访问 IBKR）见 [本地代理配置.md](./本地代理配置.md)。

## 一、背景与链路

- VPS：腾讯云东京节点 `ubuntu@43.163.224.212`
- 受限接口：新浪 `hq.sinajs.cn`、腾讯 `qt.gtimg.cn`（对海外 IP 拒绝或不稳定）
- 接口为 **GBK 编码**，代码内用 `TextDecoder('gbk')` 解码

```
容器内 fetch(新浪/腾讯)
  └─ undici ProxyAgent ─→ 宿主机 127.0.0.1:7897
        └─ ssh -R 隧道 ─→ 本机 Clash(127.0.0.1:7897, 惠州电信)
              └─ 国内直连 ─→ hq.sinajs.cn / qt.gtimg.cn

其他请求（IBKR / 长桥 / CNN / Alpha Vantage）：东京直连，不经过本机
```

---

## 二、打通 SSH（22 端口超时排查）

`Connection timed out` 表示数据包被丢弃（区别于 `refused`：主机在但无服务）。

腾讯云轻量有**两层**入站防火墙，两层都要放行：

1. **云控制台 → 防火墙**：确认 `Linux 登录(22) TCP 允许`
2. **系统内 UFW**（用腾讯云网页终端 OrcaTerm 登录操作，不依赖公网 22）：

```bash
sudo ufw status verbose          # 默认 deny incoming 时，只放行 80,443 就会卡住 22
sudo ufw allow 22/tcp comment 'OpenSSH'
```

快速定位法：`ping` 通、80/443 通而**只有 22 超时** → 主机内部防火墙问题。

## 三、手动建隧道并验证

本机执行：

```bash
ssh -R 7897:127.0.0.1:7897 ubuntu@43.163.224.212
```

VPS 上验证：

```bash
ss -tlnp | grep 7897                                          # ① 端口在监听
curl -s -x http://127.0.0.1:7897 http://myip.ipip.net         # ② 出口 IP = 本机 IP
curl -s -x http://127.0.0.1:7897 \
  -H "Referer: https://finance.sina.com.cn" \
  "https://hq.sinajs.cn/list=sh000001"                        # ③ 返回行情数据
```

> Clash 默认 `GEOIP,CN → DIRECT`，所以国内站点经隧道回到本机后是直连出口；
> 这是预期行为，不影响"VPS 能访问国内接口"的目标。

## 四、SSH 密钥免密（后台自启前提）

VPS 开启了微信扫码（keyboard-interactive）验证，后台 ssh 无人扫码会永久卡住。

在腾讯云网页终端（ubuntu 用户）执行，把本机公钥加入授权：

```bash
mkdir -p ~/.ssh
echo 'ssh-ed25519 AAAA... 799817582@qq.com' >> ~/.ssh/authorized_keys
chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys
```

本机验证免密（二维码横幅仍会显示，命令能执行即成功）：

```bash
ssh -o BatchMode=yes ubuntu@43.163.224.212 whoami   # 输出 ubuntu
```

## 五、隧道开机自启（Windows）

创建 `D:\code\tunnel.vbs`（静默后台、保活、端口被占时快速失败）：

```vbscript
' SSH 反向隧道（东京 VPS -> 本机 Clash 7897），静默后台运行
Set sh = CreateObject("WScript.Shell")
cmd = """C:\Windows\System32\OpenSSH\ssh.exe"" -N -C " & _
      "-o ServerAliveInterval=30 -o ServerAliveCountMax=3 " & _
      "-o ExitOnForwardFailure=yes -o ConnectTimeout=15 " & _
      "-R 7897:127.0.0.1:7897 ubuntu@43.163.224.212"
sh.Run cmd, 0, False
```

复制到启动文件夹（无需管理员，登录即自启）：

```
C:\Users\<用户>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\tunnel.vbs
```

参数说明：

- `-N` 纯端口转发，不开 shell
- `ExitOnForwardFailure=yes`：远程端口被旧会话占用时直接退出，**杜绝"假活"隧道**
- `ServerAliveInterval/CountMax`：约 90 秒探活，及时发现死连接

## 六、应用侧：只给新浪/腾讯挂代理

**不用全局 `http_proxy` 的原因**：

1. Node 的 fetch（undici）默认不读该环境变量
2. 全局代理会让 IBKR/长桥/CNN 全部绕家里网络，电脑一休眠全站挂

做法：`functions/api/lib/cn-premium.js` 用 undici `ProxyAgent` 按需挂载：

```js
let proxyDispatcherPromise;
function getProxyDispatcher() {
  if (!proxyDispatcherPromise) {
    proxyDispatcherPromise = (async () => {
      const proxyUrl = globalThis.process?.env?.CN_HTTP_PROXY;
      if (!proxyUrl || !globalThis.process.versions?.node) return null;
      try {
        const { ProxyAgent } = await import("undici");
        return new ProxyAgent(proxyUrl);
      } catch {
        return null;
      }
    })();
  }
  return proxyDispatcherPromise;
}

// 新浪、腾讯两个 fetch 处：
const init = { headers: { /* ... */ } };
const dispatcher = await getProxyDispatcher();
if (dispatcher) init.dispatcher = dispatcher;
const res = await fetch(url, init);
```

undici 虽是 Node 内置 fetch 的底层，但作为依赖需显式安装：

```bash
npm install undici
```

## 七、Docker 接入（host 网络）

容器内的 `127.0.0.1` 指向容器自身，访问不到宿主机隧道。
`docker-compose.yml` 改用 host 网络，容器与宿主机共享网络栈：

```yaml
services:
  dashboard:
    # ...
    network_mode: host          # 替代 ports 映射
    environment:
      HOST: 127.0.0.1
      PORT: 3000
      CN_HTTP_PROXY: http://127.0.0.1:7897   # 仅代码内两个国内请求使用
```

- 容器直接监听宿主机 `127.0.0.1:3000`，nginx 反代方式不变
- 直接访问宿主机 `127.0.0.1:7897`，无需改 sshd `GatewayPorts`
- `ports` 段删除（host 网络下不生效）

## 八、锁文件必须在 Linux 环境生成

**坑**：Windows 上的 npm（npm/cli#4828）会把 longbridge 的 Linux 可选依赖
（`longbridge-linux-x64-gnu` 等）嵌套到 `node_modules/longbridge/node_modules/` 且丢失版本号，
镜像构建时 `npm ci` 报 `Invalid Version`。

在 VPS 用容器重新生成锁文件并验证：

```bash
rm -rf /tmp/lockgen && mkdir -p /tmp/lockgen
cp package.json /tmp/lockgen/
docker run --rm -v /tmp/lockgen:/x -w /x node:current-slim \
  sh -c 'npm install --package-lock-only && npm ci --omit=dev'
# 成功后把 /tmp/lockgen/package-lock.json 取回本地、提交
scp ubuntu@43.163.224.212:/tmp/lockgen/package-lock.json ./package-lock.json
```

配套的 Dockerfile 要点：

```dockerfile
FROM node:current-slim
# ...
RUN npm ci --omit=dev
# 兜底：提升 longbridge 嵌套的原生平台包
RUN cp -r node_modules/longbridge/node_modules/* node_modules/ 2>/dev/null || true
```

## 九、部署与验证

```bash
# 本机：提交推送
git push origin master

# VPS：对齐仓库并重建
cd /opt/ibkr-cf-dashboard
sudo chown -R ubuntu:ubuntu .            # root 写入过的文件会导致 git pull 权限失败
git fetch origin && git reset --hard origin/master
sudo docker compose up -d --build

# 等 healthy 后，容器内端到端验证
sudo docker exec ibkr-dashboard node -e \
  "import('./functions/api/lib/cn-premium.js').then(async m=>console.log(await m.fetchQdiiPremium('159509',2.40)))"
# 期望：{"premiumRate":34.65,"iopv":2.372,"nav":2.3721,"scale":215.23,"navDate":"2026-09-29"}
```

回归确认其他链路不受影响：

```bash
curl -s http://127.0.0.1:3000/api/market   # source: longbridge（直连）
curl -s http://127.0.0.1:3000/healthz       # {"ok":true}
```

---

## 十、踩坑清单

| # | 现象 | 原因 | 解法 |
|---|---|---|---|
| 1 | ssh 22 超时 | 云防火墙或系统 UFW 未放行 | 两层防火墙都放行 22 |
| 2 | 旧隧道占着端口，新会话连上但请求超时 | 旧 sshd 会话"假活" | 服务器 `kill <旧 sshd PID>`；脚本加 `ExitOnForwardFailure` |
| 3 | 重连后 7897 无监听 | 重连命令漏了 `-R` | 用固定 vbs，不手敲 |
| 4 | 后台 ssh 永久卡住 | 微信扫码无人交互 | 配置密钥免密 |
| 5 | 全局代理导致电脑休眠后全站挂 | 所有出站都绕本机 | 代码内仅两个域名按需代理 |
| 6 | 容器内请求隧道不通 | 容器 127.0.0.1 ≠ 宿主机 | compose 改 host 网络 |
| 7 | `npm ci` 报 Invalid Version | Windows npm 损坏可选依赖锁 | Linux 容器内重新生成锁文件 |
| 8 | `git reset` 报 Permission denied | 文件被 root 写入 | `chown -R ubuntu:ubuntu` 项目目录 |

## 十一、日常使用

- 本机 **Clash 保持运行**；隧道断线时双击 `D:\code\tunnel.vbs` 重连
- 隧道断了只影响溢价率（新浪/腾讯）数据，仪表板主体与其他 API 正常
- 如需断线自动重连，可升级 autossh 方案
