// 场内 QDII · A股 溢价率
// 溢价率 =（现价 − IOPV 实时参考净值）÷ IOPV × 100%
//
// 主源：腾讯 qt.gtimg.cn —— 一次返回 [77]官方溢价率、[78]IOPV、[81]单位净值
//   用 IOPV 做分母比用 T-1 单位净值更贴近盘中；腾讯溢价率直接采用，避免自算误差。
// 补日期：新浪基金 f_<code> [4]=净值日期（腾讯没有日期）。
// 腾讯不可用时回退新浪单位净值 + 自算溢价（旧逻辑兜底）。
//
// 接口 GBK 编码，用 TextDecoder('gbk') 解码；QDII 美股闭市时 IOPV 冻结、盘中不跳动，
// 溢价仍含净值滞后成分，前端需展示净值日期 + IOPV 标注。
// 净值/IOPV 一天才更新一次，进程内缓存 1 小时，避免高频请求。

const GBK = new TextDecoder("gbk");

const navCache = new Map(); // code -> { iopv, nav, premiumRate, navDate, expiresAt }
const NAV_CACHE_TTL_MS = 3600 * 1000;

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 腾讯：v_sz159509="..."; 关键段 [77]=溢价率 [78]=IOPV [81]=单位净值
async function fetchTencentInfo(code) {
  const market = /^[569]/.test(code) ? "sh" : "sz"; // 沪：5/6/9 开头，深：0/1/2/3 开头
  const res = await fetch(`https://qt.gtimg.cn/q=${market}${code}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`tencent HTTP ${res.status}`);
  const text = GBK.decode(new Uint8Array(await res.arrayBuffer()));
  const m = text.match(/"([^"]*)"/);
  if (!m) throw new Error("tencent 空响应");
  const p = m[1].split("~");
  return {
    iopv: numOrNull(p[78]),
    nav: numOrNull(p[81]),
    premiumRate: numOrNull(p[77]),
    navDate: "",
  };
}

// 新浪基金：var hq_str_f_159509="名称,单位净值,累计净值,估算净值,净值日期,...";
async function fetchSinaInfo(code) {
  const res = await fetch(`https://hq.sinajs.cn/list=f_${code}`, {
    headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`sina HTTP ${res.status}`);
  const text = GBK.decode(new Uint8Array(await res.arrayBuffer()));
  const m = text.match(/"([^"]*)"/);
  if (!m) throw new Error("sina 空响应");
  const parts = m[1].split(",");
  return {
    iopv: null,
    nav: numOrNull(parts[1]),
    premiumRate: null,
    navDate: parts[4] || "",
  };
}

export async function fetchQdiiPremium(code, price) {
  const EMPTY = { premiumRate: null, iopv: null, nav: null, navDate: "" };
  if (!price || price <= 0) return EMPTY;

  let info = navCache.get(code);
  if (!info || info.expiresAt <= Date.now()) {
    const tencent = await fetchTencentInfo(code).catch(() => null);
    const sina = await fetchSinaInfo(code).catch(() => null);

    let fresh = null;
    if (tencent) {
      // 腾讯有数据：用腾讯的 IOPV/溢价率，借新浪补净值日期
      fresh = { ...tencent, navDate: sina?.navDate || tencent.navDate };
    } else if (sina) {
      fresh = sina; // 腾讯挂了：回退新浪单位净值
    }
    if (fresh) navCache.set(code, { ...fresh, expiresAt: Date.now() + NAV_CACHE_TTL_MS });
    info = fresh;
  }

  if (!info) return EMPTY;

  // 溢价率：优先腾讯现成的；否则用 IOPV/单位净值自算
  let premiumRate = info.premiumRate;
  if (premiumRate === null) {
    const base = info.iopv || info.nav;
    premiumRate = base ? Math.round(((price - base) / base) * 10000) / 100 : null;
  }

  return {
    premiumRate,
    iopv: info.iopv,
    nav: info.nav,
    navDate: info.navDate || "",
  };
}
