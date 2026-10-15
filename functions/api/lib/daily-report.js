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
  // 注意：Number(null)===0、Number("")===0，必须先排除缺失值，否则溢价缺失会被当成 0%
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function sma(closes, n) {
  const window = closes.slice(-n);
  return window.length ? window.reduce((s, x) => s + x, 0) / window.length : null;
}

// —— 美股报告 ——

async function buildUsRows(env = process.env) {
  // 年初至今取行情快照里的长桥 CalcIndex 值（整次报告一次请求）
  const ytdBySymbol = new Map();
  try {
    const resp = await marketHandler({ env, request: { url: "http://localhost/" } });
    const body = await resp.json();
    for (const q of body.quotes || []) {
      const v = num(q.ytdChangeRate);
      if (v !== null) ytdBySymbol.set(q.symbol, v);
    }
  } catch {
    // 快照失败不影响报告主体
  }

  const rows = [];
  for (const meta of US_SYMBOLS) {
    const latest = getLatest(meta.symbol);
    const livePrice = Number(latest?.price);
    const prevClose = Number(latest?.previousClose);
    const changePct = livePrice && prevClose ? (livePrice / prevClose - 1) * 100 : null;

    // 日K：近5交易日涨跌 + 一年高点回撤 + 200 日线（失败不致命，只缺这几个派生项）
    let chg5 = null;
    let dd = null;
    let vsSma200 = null;
    let tradeDate = "";
    try {
      const bars = await fetchDailyCandlesticks(meta.symbol, 210);
      if (bars?.length) {
        const closes = bars.map((b) => Number(b.close)).filter(Number.isFinite);
        const last = Number(livePrice) || closes.at(-1);
        if (closes.length >= 6) chg5 = (last / closes.at(-6) - 1) * 100;
        const peak = Math.max(...closes);
        if (peak > 0) dd = (last / peak - 1) * 100;
        const line = sma(closes, 200);
        if (line) vsSma200 = (last / line - 1) * 100;
        tradeDate = bars.at(-1).date;
      }
    } catch {
      // 日K失败保留价格行
    }

    rows.push({ ...meta, price: livePrice || null, changePct, chg5, ytd: ytdBySymbol.get(meta.symbol) ?? null, dd, vsSma200, tradeDate });
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
    if (r.chg5 !== null) extras.push(`5日 ${r.chg5 >= 0 ? "+" : ""}${r.chg5.toFixed(2)}%`);
    if (r.ytd !== null && r.ytd !== undefined) extras.push(`年内 ${r.ytd >= 0 ? "+" : ""}${r.ytd.toFixed(2)}%`);
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

  const [rows, sentiment] = await Promise.all([buildUsRows(env), buildSentiment(env)]);
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

// QDII 单只标的行：固定字段顺序 + 全角竖线分隔，手机端阅读对齐
function formatCnLine(q, minPremium) {
  const premium = num(q.premiumRate);
  const turnover = num(q.turnoverRate);
  const changePct = num(q.changePercent);
  const chg5 = num(q.chg5);
  const ytd = num(q.ytdChangeRate);
  const tags = [];
  if (premium !== null && minPremium !== null && q.premiumGroup === "NDX" && premium === minPremium) tags.push("✅组内最低");
  if (q.symbol === "159509" && premium !== null) {
    if (premium >= 40) tags.push("🔴极端溢价");
    else if (premium >= 20) tags.push("🟠溢价偏高");
  }
  const trend = chg5 !== null || ytd !== null
    ? `｜${chg5 !== null ? `5日 ${fmtSigned(chg5)}` : ""}${chg5 !== null && ytd !== null ? " " : ""}${ytd !== null ? `年内 ${fmtSigned(ytd)}` : ""}`
    : "";
  return `- **${q.symbol}** ${shortName(q.nameCn)}　${q.price ?? "-"}（${fmtSigned(changePct)}）｜溢价 ${premium === null ? "-" : premium.toFixed(2) + "%"}｜换手 ${turnover === null ? "-" : turnover.toFixed(2) + "%"}${trend}${tags.length ? `　${tags.join(" ")}` : ""}`;
}

// 建议段用短名：去掉 (QDII)/(QDII-ETF) 等括号后缀，缩短行宽
function shortName(name) {
  return String(name || "").replace(/[（(][^）)]*[)）]/g, "").trim();
}

function pctText(v) {
  return `${v.toFixed(2)}%`;
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

// 溢价框架 → 操作建议：固定五段（买入/持有/换仓/回避/结论），编号对齐便于阅读。
// 阈值取自 strategy.params（premiumCheap/premiumFair/topPremium/premiumExpensive），与 rebalance 保持一致。
function buildPremiumAdvice(quotes, heldSymbols, params) {
  const cheap = Number(params.premiumCheap) || 2;
  const fair = Number(params.premiumFair) || 5;
  const top = Number(params.topPremium) || 8;
  const expensive = Number(params.premiumExpensive) || 20;
  const SWITCH_GAP = 3; // 高出组内最低几个百分点才提示换仓

  const grouped = new Map();
  for (const q of quotes) {
    const premium = num(q.premiumRate);
    if (premium === null) continue;
    const group = q.premiumGroup || "其他";
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push({ q, premium });
  }
  for (const rows of grouped.values()) rows.sort((a, b) => a.premium - b.premium);

  const ref = (s) => `**${shortName(s.q.nameCn) || s.q.symbol}（${s.q.symbol}）**`;

  // 1️⃣ 买入：逐组判断组内最低所处区间
  const buy = [];
  for (const [group, rows] of grouped) {
    const min = rows[0];
    const label = group === "NDX" ? "纳指100" : group === "NDXTMC" ? "纳指科技" : group;
    if (min.premium <= cheap) buy.push(`🟢 ${label}：${ref(min)} ${pctText(min.premium)}，便宜区可分批买入`);
    else if (min.premium <= fair) buy.push(`🟢 ${label}：${ref(min)} ${pctText(min.premium)}，合理区可小额定投`);
  }
  if (!buy.length) {
    // 以纳指100 组最低为代表说明今天为什么不买
    const ndxMin = (grouped.get("NDX") || [])[0];
    const anyMin = ndxMin || [...grouped.values()].map((r) => r[0]).sort((a, b) => a.premium - b.premium)[0];
    buy.push(
      anyMin
        ? `暂无可买标的（组内最低 ${ref(anyMin)} 溢价 ${pctText(anyMin.premium)}，高于合理线 ${fair}%）`
        : "暂无可买标的（溢价数据不可用）"
    );
  }

  // 2️⃣ 持有 / 3️⃣ 换仓·止盈（仅针对实际持仓）
  const hold = [];
  const switchList = [];
  const ndxMinForCross = (grouped.get("NDX") || [])[0];
  for (const [group, rows] of grouped) {
    const min = rows[0];
    for (const item of rows) {
      if (!heldSymbols.has(item.q.symbol)) continue;
      if (item.premium >= expensive) {
        // 持仓本身已极端溢价（如独苗组 159509）：分批止盈；纳指100 组有明显更便宜的同类时给出跨组切换目标
        const cross =
          group !== "NDX" && ndxMinForCross && item.premium - ndxMinForCross.premium >= SWITCH_GAP
            ? `；或换入同类低溢价 ${ref(ndxMinForCross)} ${pctText(ndxMinForCross.premium)}`
            : "";
        switchList.push(`🎯 ${ref(item)} ${pctText(item.premium)} 处极端溢价，可考虑分批止盈${cross}`);
      } else if (item.q.symbol === min.q.symbol) {
        hold.push(`${ref(item)} ${pctText(item.premium)}，组内最低无需换仓`);
      } else if (item.premium > fair && item.premium - min.premium >= SWITCH_GAP) {
        switchList.push(`${ref(item)} ${pctText(item.premium)} → ${ref(min)} ${pctText(min.premium)}，省 ${(item.premium - min.premium).toFixed(2)}pp`);
      }
    }
  }

  // 4️⃣ 回避：非持仓标的按极端/过热合并列出。组内最低仅在贵到极端（≥昂贵线，
  //    如独苗组 159509）时才列；过热但未到极端的组内最低不报回避（买入段已说明）。
  const extremeAvoid = [];
  const hotAvoid = [];
  for (const rows of grouped.values()) {
    const minSymbol = rows[0].q.symbol;
    for (const item of rows) {
      if (heldSymbols.has(item.q.symbol)) continue;
      const isGroupMin = item.q.symbol === minSymbol;
      const cell = `${item.q.symbol}（${pctText(item.premium)}）`;
      if (item.premium >= expensive) extremeAvoid.push(cell);
      else if (item.premium >= top && !isGroupMin) hotAvoid.push(cell);
    }
  }
  const avoid = [];
  if (extremeAvoid.length) avoid.push(`🔴 极端（≥${expensive}%）：${extremeAvoid.join("、")}`);
  if (hotAvoid.length) avoid.push(`⚠️ 过热（≥${top}%）：${hotAvoid.join("、")}`);
  if (!avoid.length) avoid.push("无（暂无过热/极端溢价的非持仓标的）");

  // 5️⃣ 结论：以纳指100 组主基调 + 极端溢价点名
  const overallMin = (grouped.get("NDX") || [])[0];
  const anyExtreme = [...grouped.values()].flat().some((r) => r.premium >= expensive);
  let conclusion;
  if (overallMin && overallMin.premium <= cheap) {
    conclusion = `${overallMin.q.symbol} 组内最低 ${pctText(overallMin.premium)}（便宜区），可分批买入，勿追高溢价标的`;
  } else if (overallMin && overallMin.premium <= fair) {
    conclusion = `${overallMin.q.symbol} 组内最低 ${pctText(overallMin.premium)}（合理区），可小额定投`;
  } else {
    conclusion = "场内纳指 QDII 溢价普遍偏高，今日不建议买入，等溢价回落再入场";
  }
  if (anyExtreme) conclusion += "；极端溢价标的一律不碰";

  // 图标式分段：用带 U+FE0F 的标准 emoji（钉钉彩色渲染稳定）
  return [
    `- 🟢 **买入**：${buy.join("；")}`,
    `- ✅ **持有**：${hold.length ? hold.join("；") : "无"}`,
    `- 🔄 **换仓·止盈**：${switchList.length ? switchList.join("；") : "无"}`,
    `- ⚠️ **回避**：${avoid.join("　")}`,
    `- 📌 **结论**：${conclusion}`,
  ];
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
    const [rows, sentiment] = await Promise.all([buildUsRows(env), buildSentiment(env)]);
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
