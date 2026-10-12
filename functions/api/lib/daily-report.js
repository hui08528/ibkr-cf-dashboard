// 每日收盘日报 —— 定时（非阈值）推送，与 alert-engine 的事件型告警互补
//
// 两类报告（均为北京时间窗口，调度器每分钟调一次 maybeDailyReports）：
//   1) 美股收盘报告：04:05–06:30 窗口，行情时间戳确认收盘（ET≥16:02）后推送
//      QQQ/VOO/VGT/SMH 的现价、日涨跌、距一年高点、200 日线上/下方
//   2) A股 QDII 收盘报告：15:05–15:45 窗口，cnQuotes 出现新交易日即推送
//      5 只 QDII 的现价、溢价率、换手率；NDX 组内最低溢价打标，159509 极端溢价警示
//
// 去重状态存 /data/report-state.json（{usDate, cnDate}），容器重启不重复推；
// 用"数据已更新到新交易日"而非日历判断，周末/节假日/夏令时自动适配。

import fs from "node:fs";
import path from "node:path";
import { getLatest } from "./quote-stream.js";
import { fetchDailyCandlesticks } from "./longbridge.js";
import { sendToDingtalk } from "./dingtalk.js";
import { onRequestGet as marketHandler } from "../market.js";

const US_SYMBOLS = [
  { symbol: "QQQ", name: "纳指100" },
  { symbol: "VOO", name: "标普500" },
  { symbol: "VGT", name: "信息科技" },
  { symbol: "SMH", name: "半导体" },
];

const BJ_TZ = "Asia/Shanghai";
const US_TZ = "America/New_York";

function envValue(key, env) {
  const value = env[key];
  return value === undefined ? "" : String(value).trim();
}

function stateFile(env) {
  return envValue("REPORT_STATE_FILE", env) || "/data/report-state.json";
}

function loadState(env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(env), "utf8"));
    return { usDate: parsed.usDate || "", cnDate: parsed.cnDate || "" };
  } catch {
    return { usDate: "", cnDate: "" };
  }
}

function saveState(state, env) {
  try {
    const file = stateFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    const next = { ...state, updatedAt: new Date().toISOString() };
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    console.warn(`[daily-report] 状态落盘失败: ${error.message}`);
  }
}

function tzDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function tzParts(date, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return parts;
}

function bjLabel(date = new Date()) {
  const p = tzParts(date, BJ_TZ);
  return `${String(p.year)}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function fmtSigned(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

function sma(closes, n) {
  const window = closes.slice(-n);
  return window.length ? window.reduce((s, x) => s + x, 0) / window.length : null;
}

// —— 美股报告 ——

async function buildUsRows() {
  const rows = [];
  for (const meta of US_SYMBOLS) {
    const latest = getLatest(meta.symbol);
    const livePrice = Number(latest?.price);
    const prevClose = Number(latest?.previousClose);
    const changePct = livePrice && prevClose ? (livePrice / prevClose - 1) * 100 : null;

    // 日K：一年高点回撤 + 200 日线（失败不致命，只缺这两个派生项）
    let dd = null;
    let vsSma200 = null;
    let tradeDate = "";
    try {
      const bars = await fetchDailyCandlesticks(meta.symbol, 210);
      if (bars?.length) {
        const closes = bars.map((b) => Number(b.close)).filter(Number.isFinite);
        const last = Number(livePrice) || closes.at(-1);
        const peak = Math.max(...closes);
        if (peak > 0) dd = (last / peak - 1) * 100;
        const line = sma(closes, 200);
        if (line) vsSma200 = (last / line - 1) * 100;
        tradeDate = bars.at(-1).date;
      }
    } catch {
      // 日K失败保留价格行
    }

    rows.push({ ...meta, price: livePrice || null, changePct, dd, vsSma200, tradeDate });
  }
  return rows;
}

function renderUs(rows, tradeDate) {
  const lines = [`### 📊 美股收盘日报（${tradeDate}）`];
  for (const r of rows) {
    if (!r.price) {
      lines.push(`- **${r.symbol}** ${r.name}：暂无行情`);
      continue;
    }
    const extras = [];
    if (r.dd !== null) extras.push(`距高点 ${r.dd >= 0 ? "+" : ""}${r.dd.toFixed(1)}%`);
    if (r.vsSma200 !== null) extras.push(`年线${r.vsSma200 >= 0 ? "上方 +" : "下方 "}${Math.abs(r.vsSma200).toFixed(1)}%`);
    lines.push(
      `- **${r.symbol}** ${r.name}：${r.price}（${fmtSigned(r.changePct)}）${extras.length ? ` · ${extras.join(" · ")}` : ""}`
    );
  }
  lines.push(`> 推送时间：${bjLabel()}（北京时间）`);
  return lines.join("\n");
}

// 收盘确认：最新行情时间戳进入 ET 16:02 后；无精确时间戳时在北京 05:10 后兜底（冬令时收盘 05:00）
function isUsMarketClosed(latest, bjMinute) {
  const ts = latest?.ts ? Date.parse(latest.ts) : NaN;
  if (Number.isFinite(ts)) {
    const et = tzParts(new Date(ts), US_TZ);
    return et.hour > 16 || (et.hour === 16 && et.minute >= 2);
  }
  return bjMinute >= 510;
}

async function maybeUs(state, env) {
  const now = new Date();
  const bj = tzParts(now, BJ_TZ);
  const hm = bj.hour * 100 + bj.minute;
  if (hm < 405 || hm > 630) return { sent: false, reason: "out-of-window" };

  const rows = await buildUsRows();
  const dated = rows.filter((r) => r.tradeDate);
  const tradeDate = tzDate(now, US_TZ);
  if (state.usDate === tradeDate) return { sent: false, reason: "already-sent" };
  if (!dated.length) return { sent: false, reason: "no-kline" };

  const qqqLatest = getLatest("QQQ");
  if (!isUsMarketClosed(qqqLatest, hm)) return { sent: false, reason: "market-open" };

  const sent = await sendToDingtalk(renderUs(rows, tradeDate), "📊 美股收盘日报", env);
  if (sent.ok) {
    state.usDate = tradeDate;
    saveState(state, env);
  }
  return { sent: sent.ok, tradeDate, errors: sent.errors };
}

// —— A股 QDII 报告 ——

async function fetchCnQuotes(env) {
  const response = await marketHandler({ env, request: { url: "http://localhost/" } });
  const body = await response.json();
  return Array.isArray(body.cnQuotes) ? body.cnQuotes : [];
}

function renderCn(quotes, tradeDate) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const ndx = quotes.filter((q) => q.premiumGroup === "NDX").filter((q) => num(q.premiumRate) !== null);
  const minPremium = ndx.length ? Math.min(...ndx.map((q) => num(q.premiumRate))) : null;

  const line = (q) => {
    const premium = num(q.premiumRate);
    const turnover = num(q.turnoverRate);
    const changePct = num(q.changePercent);
    const tags = [];
    if (premium !== null && minPremium !== null && q.premiumGroup === "NDX" && premium === minPremium) tags.push("✅组内最低");
    if (q.symbol === "159509" && premium !== null) {
      if (premium >= 40) tags.push("🔴极端溢价");
      else if (premium >= 20) tags.push("🟠溢价偏高");
    }
    return `- **${q.symbol}** ${q.nameCn || ""}：${q.price ?? "-"}（${fmtSigned(changePct)}）· 溢价 ${premium === null ? "-" : premium.toFixed(2) + "%"} · 换手 ${turnover === null ? "-" : turnover.toFixed(2) + "%"}${tags.length ? ` ${tags.join(" ")}` : ""}`;
  };

  const tech = quotes.filter((q) => q.symbol === "159509");
  const ndxSorted = [...ndx].sort((a, b) => num(a.premiumRate) - num(b.premiumRate));

  const lines = [`### 📊 QDII 收盘日报（${tradeDate}）`, "**纳指科技（NDXTMC）**"];
  for (const q of tech) lines.push(line(q));
  lines.push("**纳指100（NDX）**");
  for (const q of ndxSorted) lines.push(line(q));
  lines.push(`> 推送时间：${bjLabel()}（北京时间）`);
  return lines.join("\n");
}

async function maybeCn(state, env) {
  const now = new Date();
  const bj = tzParts(now, BJ_TZ);
  const hm = bj.hour * 100 + bj.minute;
  if (hm < 1505 || hm > 1545) return { sent: false, reason: "out-of-window" };

  const quotes = await fetchCnQuotes(env);
  // tradingDay 是长桥给的最新交易日；休市日它停在上一交易日，天然去重
  const tradeDate = quotes.map((q) => q.tradingDay).filter(Boolean).sort().at(-1) || tzDate(now, BJ_TZ);
  if (!tradeDate || state.cnDate === tradeDate) return { sent: false, reason: "already-sent" };

  const sent = await sendToDingtalk(renderCn(quotes, tradeDate), "📊 QDII收盘日报", env);
  if (sent.ok) {
    state.cnDate = tradeDate;
    saveState(state, env);
  }
  return { sent: sent.ok, tradeDate, errors: sent.errors };
}

// —— 调度入口 / 手动触发 ——

export async function maybeDailyReports(env = process.env) {
  if (String(env.REPORT_ENABLED ?? "true").toLowerCase() === "false") {
    return { enabled: false };
  }
  const state = loadState(env);
  const [us, cn] = await Promise.all([
    maybeUs(state, env).catch((error) => ({ sent: false, reason: error.message })),
    maybeCn(state, env).catch((error) => ({ sent: false, reason: error.message })),
  ]);
  return { enabled: true, us, cn };
}

// 手动/测试：忽略窗口与去重，立即生成并推送；kind: "us" | "cn"
export async function forceReport(kind, env = process.env) {
  if (kind === "us") {
    const rows = await buildUsRows();
    const tradeDate = rows.find((r) => r.tradeDate)?.tradeDate || tzDate(new Date(), US_TZ);
    const content = renderUs(rows, tradeDate);
    const sent = await sendToDingtalk(content, "📊 美股收盘日报", env);
    return { kind, tradeDate, sent, preview: content };
  }
  const quotes = await fetchCnQuotes(env);
  const tradeDate = quotes.map((q) => q.tradingDay).filter(Boolean).sort().at(-1) || tzDate(new Date(), BJ_TZ);
  const content = renderCn(quotes, tradeDate);
  const sent = await sendToDingtalk(content, "📊 QDII收盘日报", env);
  return { kind, tradeDate, sent, preview: content };
}
