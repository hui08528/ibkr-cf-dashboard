// 长桥实时行情流 —— 单例 WebSocket 订阅 + 广播分发
//
// 一条到长桥的 QuoteContext 长连接订阅全部标的（美股 6 + QDII 5），
// 进程内维护最新价；SSE 连接作为订阅者接收推送。
// 启动时先用 /api/market REST 快照播种（含昨收），WS 首帧到达前前端也有数据可渲染。
//
// 注意：长桥 A 股 LV1 实时行情仅限大陆 IP，海外 VPS 订阅 159xxx.SZ 可能为延迟行情；
// 状态里带 tradeSession/延迟判断，由前端标注。

import { createRequire } from "node:module";
import { getSharedCtx } from "./longbridge.js";
import { onRequestGet as marketHandler, usInstruments, cnInstruments } from "../market.js";

const requireCjs = createRequire(import.meta.url);

// 长桥 symbol → 前端短代码
const shortByLb = new Map();
for (const inst of usInstruments) shortByLb.set(inst.longbridgeSymbol || `${inst.symbol}.US`, inst.symbol);
for (const inst of cnInstruments) shortByLb.set(inst.longbridgeSymbol, inst.symbol);
const allLbSymbols = [...shortByLb.keys()];

// short -> 最新一条行情
const latest = new Map();
const subscribers = new Set(); // (event) => void

let startPromise = null;
let status = "idle"; // idle | starting | live | error
let lastError = "";

function dec(value) {
  if (value === null || value === undefined) return null;
  if (typeof value.toNumber === "function") {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function broadcast(event) {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      // 单个订阅者出错不影响其他人
    }
  }
}

// 用 REST 快照播种：price / previousClose / 开高低
async function seedFromSnapshot(env) {
  try {
    const response = await marketHandler({ env, request: { url: "http://localhost/" } });
    const body = await response.json();
    const seed = (quote) => {
      if (!quote?.symbol) return;
      latest.set(quote.symbol, {
        symbol: quote.symbol,
        price: Number(quote.price) || null,
        previousClose: Number(quote.previousClose) || null,
        open: Number(quote.open) || null,
        high: Number(quote.high) || null,
        low: Number(quote.low) || null,
        ts: quote.tradingDay || "",
        live: false,
      });
    };
    for (const quote of body.quotes || []) seed(quote);
    for (const quote of body.cnQuotes || []) seed(quote);
  } catch (error) {
    console.warn(`[quote-stream] 快照播种失败: ${error.message}`);
  }
}

// 幂等启动：首次调用建连接并订阅，并发调用共用同一 promise
export function ensureStarted(env = {}) {
  if (startPromise) return startPromise;
  status = "starting";

  startPromise = (async () => {
    await seedFromSnapshot(env);

    const ctx = await getSharedCtx();
    if (!ctx) throw new Error("长桥未配置或不可用");
    const lb = requireLongbridge();
    if (!lb) throw new Error("longbridge SDK 未安装");

    ctx.setOnQuote((err, event) => {
      if (err) {
        console.warn(`[quote-stream] 推送错误: ${err.message}`);
        return;
      }
      const symbol = shortByLb.get(event.symbol);
      if (!symbol) return;
      const d = event.data;
      const previous = latest.get(symbol);
      const row = {
        symbol,
        price: dec(d.lastDone),
        previousClose: previous?.previousClose ?? null,
        open: dec(d.open),
        high: dec(d.high),
        low: dec(d.low),
        volume: typeof d.volume === "number" ? d.volume : Number(d.volume),
        turnover: dec(d.turnover),
        ts: d.timestamp ? new Date(d.timestamp).toISOString() : "",
        tradeStatus: Number(d.tradeStatus),
        session: String(d.tradeSession ?? ""),
        live: true,
      };
      latest.set(symbol, row);
      status = "live";
      broadcast({ type: "quote", ...row });
    });

    await ctx.subscribe(allLbSymbols, [lb.SubType.Quote]);
    status = "live";
    console.log(`[quote-stream] 已订阅 ${allLbSymbols.length} 个标的`);
  })().catch((error) => {
    status = "error";
    lastError = error.message;
    startPromise = null; // 允许下次 SSE 连接重试
    throw error;
  });

  return startPromise;
}

// SDK 以 CJS 导出，复用 longbridge.js 里的 createRequire 约定（这里独立 require）
function requireLongbridge() {
  try {
    return requireCjs("longbridge");
  } catch {
    return null;
  }
}

// —— 订阅者接口（SSE 层使用）——

export function addSubscriber(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function snapshotEvent() {
  return {
    type: "snapshot",
    status,
    quotes: Object.fromEntries(latest),
  };
}

export function streamStatus() {
  return { status, lastError };
}
