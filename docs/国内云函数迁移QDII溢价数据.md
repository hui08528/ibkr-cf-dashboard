# 国内云函数迁移 QDII 溢价数据

## 目的

东京 VPS 继续获取 Longbridge 的场内 ETF 价格；腾讯云函数负责从国内行情源获取 QDII 的溢价率、IOPV、单位净值、净值日期和基金规模。

这样东京 VPS 不需要直连腾讯或新浪，也不依赖本机代理长期运行。

```text
东京 VPS
├── Longbridge：场内 ETF 价格
└── 腾讯云函数：QDII 溢价、IOPV、净值、净值日期、规模
    ├── 腾讯 qt.gtimg.cn
    └── 新浪 hq.sinajs.cn
```

## 一、创建腾讯云函数

在腾讯云 SCF 创建函数：

- 函数类型：Web 函数
- 函数名称：`qdii-premium`
- 地域：广州
- 运行环境：Node.js 20.19
- 时区：`Asia/Shanghai`
- 提交方式：在线编辑
- 监听端口：`9000`

将 [app.js.txt](<D:/Downloads/1/app.js.txt>) 中的代码复制到函数编辑器的 `app.js`。

### app.js 完整代码

```js
const express = require("express");

const app = express();
const port = 9000;
const token = process.env.PREMIUM_TOKEN;

const gbk = new TextDecoder("gbk");

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function authorized(req) {
  const requestToken = req.get("x-api-token") || req.query.token || "";
  return token && requestToken === token;
}

async function fetchTencent(code) {
  const market = /^[569]/.test(code) ? "sh" : "sz";
  const response = await fetch(`https://qt.gtimg.cn/q=${market}${code}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!response.ok) throw new Error(`Tencent HTTP ${response.status}`);

  const text = gbk.decode(new Uint8Array(await response.arrayBuffer()));
  const match = text.match(/"([^\"]*)"/);
  if (!match) throw new Error("Tencent empty response");

  const fields = match[1].split("~");
  return {
    premiumRate: numberOrNull(fields[77]),
    iopv: numberOrNull(fields[78]),
    nav: numberOrNull(fields[81]),
    scale: numberOrNull(fields[44]),
    turnoverRate: numberOrNull(fields[38]),
  };
}

async function fetchSina(code) {
  const response = await fetch(`https://hq.sinajs.cn/list=f_${code}`, {
    headers: {
      Referer: "https://finance.sina.com.cn/",
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) throw new Error(`Sina HTTP ${response.status}`);

  const text = gbk.decode(new Uint8Array(await response.arrayBuffer()));
  const match = text.match(/"([^\"]*)"/);
  if (!match) throw new Error("Sina empty response");

  const fields = match[1].split(",");
  return {
    nav: numberOrNull(fields[1]),
    navDate: fields[4] || "",
  };
}

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "qdii-premium" });
});

app.get("/qdii-premium", async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const codes = String(req.query.codes || "159509")
    .split(",")
    .map((code) => code.trim())
    .filter((code) => /^\d{6}$/.test(code))
    .slice(0, 20);

  const result = {};

  for (const code of codes) {
    const [tencent, sina] = await Promise.all([
      fetchTencent(code).catch(() => null),
      fetchSina(code).catch(() => null),
    ]);

    result[code] = {
      premiumRate: tencent?.premiumRate ?? null,
      iopv: tencent?.iopv ?? null,
      nav: tencent?.nav ?? sina?.nav ?? null,
      scale: tencent?.scale ?? null,
      turnoverRate: tencent?.turnoverRate ?? null,
      navDate: sina?.navDate ?? "",
      fetchedAt: new Date().toISOString(),
    };
  }

  res.json(result);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`QDII premium service listening on port ${port}`);
});
```

## 二、配置云函数环境变量

进入「函数配置 → 环境变量」，新增：

```text
键：PREMIUM_TOKEN
值：qdii_2026_a8f31c9e_x7p2
```

如果页面中已有下面这项，可以删除，因为函数配置已经设置了时区：

```text
TZ=Asia/Shanghai
```

保存后进入「函数代码」，点击「部署」。

## 三、创建函数 URL

进入「函数 URL」，创建公网 URL：

- 公网访问：启用
- 授权类型：开放
- CORS：不需要

当前函数地址：

```text
https://1499821740-63x5s6igsx.ap-guangzhou.tencentscf.com
```

数据接口：

```text
https://1499821740-63x5s6igsx.ap-guangzhou.tencentscf.com/qdii-premium
```

## 四、测试云函数

```bash
curl -sS \
  'https://1499821740-63x5s6igsx.ap-guangzhou.tencentscf.com/qdii-premium?codes=159509,159941,513100&token=qdii_2026_a8f31c9e_x7p2'
```

正常返回包括：

```json
{
  "159509": {
    "premiumRate": 39.8,
    "iopv": 2.3927,
    "nav": 2.393,
    "scale": 226.61,
    "navDate": "2026-10-08"
  }
}
```

其中 `navDate` 是单位净值日期，`fetchedAt` 才是云函数实际抓取时间。QDII 的净值日期滞后是正常现象。

## 五、项目配置

项目文件 [functions/api/lib/cn-premium.js](../functions/api/lib/cn-premium.js) 已改为优先请求国内云函数。

项目根目录 `.env` 中配置：

```env
CN_PREMIUM_API_URL=https://1499821740-63x5s6igsx.ap-guangzhou.tencentscf.com/qdii-premium
CN_PREMIUM_API_TOKEN=qdii_2026_a8f31c9e_x7p2
```

`.env.example` 也包含对应配置项：

```env
CN_PREMIUM_API_URL=
CN_PREMIUM_API_TOKEN=
```

## 六、重启项目

Docker 部署：

```bash
docker compose up -d --build
```

直接运行 Node：

```bash
npm start
```

## 七、验证主项目

```bash
curl -s http://127.0.0.1:3000/api/market
```

检查 `cnQuotes` 中是否包含：

```text
premiumRate
iopv
nav
navDate
scale
turnoverRate
```

当前项目已经通过本地检查，并验证了 `/api/market` 能返回腾讯云函数提供的 QDII 数据。

## 八、数据来源划分

| 数据 | 来源 |
|---|---|
| QDII 场内价格 | Longbridge |
| QDII 溢价率 | 腾讯云函数转发腾讯行情 |
| QDII IOPV | 腾讯云函数转发腾讯行情 |
| 单位净值 | 腾讯云函数转发腾讯/新浪行情 |
| 净值日期 | 腾讯云函数转发新浪行情 |
| 基金规模 | 腾讯云函数转发腾讯行情 |
| QDII 换手率 | 腾讯云函数转发腾讯行情（字段 38） |
| 美股行情 | Longbridge / Alpha Vantage |
| 财报日历 | Finnhub / Longbridge / Alpha Vantage |
| CNN 恐慌贪婪指数 | CNN |
| IBKR 持仓 | IBKR Flex |
| OKX 资产 | OKX |

## 注意事项

- `PREMIUM_TOKEN` 和 `CN_PREMIUM_API_TOKEN` 不要提交到 Git。
- 如果 Token 泄露，应先在腾讯云函数环境变量中更换，再同步更新 VPS 的 `.env`。
- 云函数只负责国内 QDII 数据，Longbridge、IBKR、CNN、OKX 等请求仍由东京 VPS 直接访问。
