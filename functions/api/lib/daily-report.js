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
import { fetchDailyCandlesticks, fetchQuote } from "./longbridge.js";
import { sendToDingtalk } from "./dingtalk.js";
import { onRequestGet as marketHandler } from "../market.js";
import { onRequestGet as fearGreedHandler } from "../fear-greed.js";
import { loadStrategy } from "./strategy-store.js";

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
    return {
      usDate: parsed.usDate || "",
      cnDate: parsed.cnDate || "",
      cnIntraday1300: parsed.cnIntraday1300 || "",
      cnIntraday1330: parsed.cnIntraday1330 || "",
    };
  } catch {
    return { usDate: "", cnDate: "", cnIntraday1300: "", cnIntraday1330: "" };
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

function num(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
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

// 情绪面：CNN 恐慌贪婪（收盘后更新一次，日报天然是收盘值）+ VIX 原值（长桥 .VIX.US）
async function buildSentiment(env) {
  const out = { fg: null, vix: null };
  const [fgResponse, vixQuote] = await Promise.all([
    fearGreedHandler({ env, request: { url: "http://localhost/" } }).then((r) => r.json()).catch(() => null),
    fetchQuote("VIX", { symbol: "VIX", longbridgeSymbol: ".VIX.US" }).catch(() => null),
  ]);

  const score = Number(fgResponse?.index?.score);
  if (Number.isFinite(score)) {
    const comp = Object.fromEntries((fgResponse.components || []).map((c) => [c.key, c.score]));
    out.fg = {
      score,
      rating: fgResponse.index.ratingCn || fgResponse.index.rating || "",
      momentum: comp.market_momentum_sp125 ?? null,
      vixScore: comp.market_volatility_vix ?? null,
      breadth: comp.stock_price_breadth ?? null,
    };
  }

  const vix = Number(vixQuote?.price);
  if (Number.isFinite(vix) && vix > 0) out.vix = vix;
  return out;
}

function vixRegime(v) {
  if (v >= 40) return "极度恐慌";
  if (v >= 30) return "恐慌";
  if (v >= 20) return "波动偏高";
  if (v >= 15) return "平稳";
  return "低位平静（偏自满）";
}

function renderSentiment(s) {
  const lines = [];
  if (s.fg) {
    const parts = [];
    if (s.fg.vixScore !== null) parts.push(`VIX分项 ${s.fg.vixScore}`);
    if (s.fg.momentum !== null) parts.push(`动量 ${s.fg.momentum}`);
    if (s.fg.breadth !== null) parts.push(`广度 ${s.fg.breadth}`);
    lines.push(`- 恐慌贪婪：**${s.fg.score} ${s.fg.rating}**${parts.length ? `（${parts.join(" · ")}）` : ""}`);
  }
  if (s.vix !== null) lines.push(`- VIX：**${s.vix}**（${vixRegime(s.vix)}）`);
  return lines;
}

function renderUs(rows, tradeDate, sentiment) {
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
      `- **${r.symbol}** ${r.name}：${Number(r.price).toFixed(2)}（${fmtSigned(r.changePct)}）${extras.length ? ` · ${extras.join(" · ")}` : ""}`
    );
  }
  const sentimentLines = renderSentiment(sentiment);
  if (sentimentLines.length) {
    lines.push("**情绪面**");
    lines.push(...sentimentLines);
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

  const [rows, sentiment] = await Promise.all([buildUsRows(), buildSentiment(env)]);
  const dated = rows.filter((r) => r.tradeDate);
  const tradeDate = tzDate(now, US_TZ);
  if (state.usDate === tradeDate) return { sent: false, reason: "already-sent" };
  if (!dated.length) return { sent: false, reason: "no-kline" };

  const qqqLatest = getLatest("QQQ");
  if (!isUsMarketClosed(qqqLatest, hm)) return { sent: false, reason: "market-open" };

  const sent = await sendToDingtalk(renderUs(rows, tradeDate, sentiment), "📊 美股收盘日报", env);
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

// QDII 单只标的行：现价、涨跌、溢价率、换手率，附组内最低/极端溢价打标
function formatCnLine(q, minPremium) {
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
}

function renderCn(quotes, tradeDate) {
  const ndx = quotes.filter((q) => q.premiumGroup === "NDX").filter((q) => num(q.premiumRate) !== null);
  const minPremium = ndx.length ? Math.min(...ndx.map((q) => num(q.premiumRate))) : null;

  const tech = quotes.filter((q) => q.symbol === "159509");
  const ndxSorted = [...ndx].sort((a, b) => num(a.premiumRate) - num(b.premiumRate));

  const lines = [`### 📊 QDII 收盘日报（${tradeDate}）`, "**纳指科技（NDXTMC）**"];
  for (const q of tech) lines.push(formatCnLine(q, minPremium));
  lines.push(""); // 空行断开钉钉 markdown 列表延续，让组标题单独成行
  lines.push("**纳指100（NDX）**");
  for (const q of ndxSorted) lines.push(formatCnLine(q, minPremium));
  lines.push(`> 推送时间：${bjLabel()}（北京时间）`);
  return lines.join("\n");
}

// 溢价框架 → 操作建议：组内最低打买入首选，持仓给换仓提示，过热/极端溢价列回避。
// 阈值取自 strategy.params（premiumCheap/premiumFair/topPremium/premiumExpensive），与 rebalance 保持一致。
function buildPremiumAdvice(quotes, heldSymbols, params) {
  const cheap = Number(params.premiumCheap) || 2;
  const fair = Number(params.premiumFair) || 5;
  const top = Number(params.topPremium) || 8;
  const expensive = Number(params.premiumExpensive) || 20;

  const grouped = new Map();
  for (const q of quotes) {
    const premium = num(q.premiumRate);
    if (premium === null) continue;
    const group = q.premiumGroup || "其他";
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push({ q, premium });
  }

  const lines = [];
  const avoid = [];

  for (const [group, rows] of grouped) {
    rows.sort((a, b) => a.premium - b.premium);
    const min = rows[0];
    const groupMin = min.premium;
    const minName = min.q.nameCn || min.q.symbol;

    // 组内最低标的：决定「今天能不能买」的主基调
    if (groupMin <= cheap) {
      lines.push(`🟢 可买：**${minName}（${min.q.symbol}）** 组内最低溢价 ${groupMin.toFixed(2)}%，处便宜区（≤${cheap}%）`);
    } else if (groupMin <= fair) {
      lines.push(`🟢 可买：**${minName}（${min.q.symbol}）** 组内最低溢价 ${groupMin.toFixed(2)}%，处合理区（≤${fair}%）`);
    } else if (groupMin < expensive) {
      lines.push(`🟠 观望：${group} 组内最低也溢价 ${groupMin.toFixed(2)}%（>${fair}%），今天不建议追买`);
    } else {
      lines.push(`🔴 回避：**${minName}（${min.q.symbol}）** 溢价 ${groupMin.toFixed(2)}%，≥ 昂贵线 ${expensive}%，勿追`);
    }

    // 结合持仓：组内最低 → 继续持有；溢价高且高出组内最低 ≥3pp → 换仓
    for (const { q, premium } of rows) {
      if (!heldSymbols.has(q.symbol)) continue;
      if (q.symbol === min.q.symbol) {
        if (groupMin < expensive) lines.push(`✅ 持有 **${minName}（${min.q.symbol}）**：组内最低，无需换仓`);
      } else if (premium > fair && premium - groupMin >= 3) {
        lines.push(`🔄 换仓：你持有的 **${q.nameCn || q.symbol}（${q.symbol}）** 溢价 ${premium.toFixed(2)}%，高出组内最低 ${(premium - groupMin).toFixed(2)}pp，建议换到 **${minName}（${min.q.symbol}）**`);
      }
    }

    // 非组内最低、且溢价过热的其余标的 → 回避提示（已持仓的走上面的换仓行，不重复列）
    for (const { q, premium } of rows) {
      if (q.symbol === min.q.symbol || heldSymbols.has(q.symbol)) continue;
      if (premium >= expensive) avoid.push(`🔴 回避：**${q.nameCn || q.symbol}（${q.symbol}）** 溢价 ${premium.toFixed(2)}%，≥ 昂贵线 ${expensive}%`);
      else if (premium >= top) avoid.push(`⚠️ 回避：**${q.nameCn || q.symbol}（${q.symbol}）** 溢价 ${premium.toFixed(2)}%，≥ 过热线 ${top}%`);
    }
  }

  lines.push(...avoid);

  // 结论：以纳指100 组为主基调 + 极端溢价点名
  const ndxRows = (grouped.get("NDX") || []).sort((a, b) => a.premium - b.premium);
  const overallMin = ndxRows[0];
  const anyExtreme = [...grouped.values()].flat().some((r) => r.premium >= expensive);
  let conclusion;
  if (overallMin && overallMin.premium <= cheap) {
    conclusion = `结论：纳指100 组内最低溢价 ${overallMin.premium.toFixed(2)}%（便宜区），可分批买入 ${overallMin.q.symbol}，勿追高溢价标的`;
  } else if (overallMin && overallMin.premium <= fair) {
    conclusion = `结论：纳指100 组内最低溢价 ${overallMin.premium.toFixed(2)}%（合理区），可小额定投 ${overallMin.q.symbol}`;
  } else {
    conclusion = "结论：场内纳指 QDII 溢价普遍偏高，今天不建议买入，等溢价回落再入场";
  }
  if (anyExtreme) conclusion += "；极端溢价标的一律不碰";
  lines.push(`📌 ${conclusion}`);

  return lines;
}

// QDII 盘中日报（13:00 / 13:30 槽位）：同收盘日报的标的数据 + 操作建议段
export function renderCnIntraday(quotes, tradeDate, slot, env = process.env) {
  const label = slot === "1330" ? "13:30" : "13:00";
  const ndx = quotes.filter((q) => q.premiumGroup === "NDX").filter((q) => num(q.premiumRate) !== null);
  const minPremium = ndx.length ? Math.min(...ndx.map((q) => num(q.premiumRate))) : null;
  const tech = quotes.filter((q) => q.symbol === "159509");
  const ndxSorted = [...ndx].sort((a, b) => num(a.premiumRate) - num(b.premiumRate));

  const strategy = loadStrategy(env);
  const held = new Set((strategy.manualPositions || []).map((p) => p.symbol));

  const lines = [`### 📊 QDII 盘中日报（${tradeDate} · ${label}）`, "**纳指科技（NDXTMC）**"];
  for (const q of tech) lines.push(formatCnLine(q, minPremium));
  lines.push(""); // 空行断开钉钉 markdown 列表延续，让组标题单独成行
  lines.push("**纳指100（NDX）**");
  for (const q of ndxSorted) lines.push(formatCnLine(q, minPremium));
  lines.push(""); // 空行断开列表延续
  lines.push("**操作建议（纳指框架·溢价）**");
  lines.push(...buildPremiumAdvice(quotes, held, strategy.params));
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

// —— QDII 盘中日报 ——
// 13:00 / 13:30 各推一次，窗口留几十秒冗余防调度抖动；按 tradeDate 去重（休市日天然跳过）。
const CN_INTRADAY_SLOTS = {
  "1300": { min: 1258, max: 1305, key: "cnIntraday1300", title: "📊 QDII盘中日报（13:00）" },
  "1330": { min: 1328, max: 1335, key: "cnIntraday1330", title: "📊 QDII盘中日报（13:30）" },
};

async function maybeCnIntraday(state, env, slot) {
  if (String(env.CN_INTRADAY_ENABLED ?? "true").toLowerCase() === "false") {
    return { sent: false, reason: "CN_INTRADAY_ENABLED=false" };
  }
  const conf = CN_INTRADAY_SLOTS[slot];
  if (!conf) return { sent: false, reason: `unknown-slot:${slot}` };

  const now = new Date();
  const bj = tzParts(now, BJ_TZ);
  const hm = bj.hour * 100 + bj.minute;
  if (hm < conf.min || hm > conf.max) return { sent: false, reason: "out-of-window" };

  const quotes = await fetchCnQuotes(env);
  const tradeDate = quotes.map((q) => q.tradingDay).filter(Boolean).sort().at(-1) || tzDate(now, BJ_TZ);
  if (!tradeDate || state[conf.key] === tradeDate) return { sent: false, reason: "already-sent" };

  const sent = await sendToDingtalk(renderCnIntraday(quotes, tradeDate, slot, env), conf.title, env);
  if (sent.ok) {
    state[conf.key] = tradeDate;
    saveState(state, env);
  }
  return { sent: sent.ok, tradeDate, slot, errors: sent.errors };
}

// —— 调度入口 / 手动触发 ——

export async function maybeDailyReports(env = process.env) {
  if (String(env.REPORT_ENABLED ?? "true").toLowerCase() === "false") {
    return { enabled: false };
  }
  const state = loadState(env);
  const [us, cn, cnIntraday1300, cnIntraday1330] = await Promise.all([
    maybeUs(state, env).catch((error) => ({ sent: false, reason: error.message })),
    maybeCn(state, env).catch((error) => ({ sent: false, reason: error.message })),
    maybeCnIntraday(state, env, "1300").catch((error) => ({ sent: false, reason: error.message })),
    maybeCnIntraday(state, env, "1330").catch((error) => ({ sent: false, reason: error.message })),
  ]);
  return { enabled: true, us, cn, cnIntraday1300, cnIntraday1330 };
}

// 手动/测试：忽略窗口与去重，立即生成并推送；kind: "us" | "cn" | "cn-1300" | "cn-1330"
export async function forceReport(kind, env = process.env) {
  if (kind === "us") {
    const [rows, sentiment] = await Promise.all([buildUsRows(), buildSentiment(env)]);
    const tradeDate = rows.find((r) => r.tradeDate)?.tradeDate || tzDate(new Date(), US_TZ);
    const content = renderUs(rows, tradeDate, sentiment);
    const sent = await sendToDingtalk(content, "📊 美股收盘日报", env);
    return { kind, tradeDate, sent, preview: content };
  }
  const slot = kind === "cn-1300" ? "1300" : kind === "cn-1330" ? "1330" : null;
  const quotes = await fetchCnQuotes(env);
  const tradeDate = quotes.map((q) => q.tradingDay).filter(Boolean).sort().at(-1) || tzDate(new Date(), BJ_TZ);
  if (slot) {
    const content = renderCnIntraday(quotes, tradeDate, slot, env);
    const sent = await sendToDingtalk(content, CN_INTRADAY_SLOTS[slot].title, env);
    return { kind, tradeDate, sent, preview: content };
  }
  const content = renderCn(quotes, tradeDate);
  const sent = await sendToDingtalk(content, "📊 QDII收盘日报", env);
  return { kind, tradeDate, sent, preview: content };
}
