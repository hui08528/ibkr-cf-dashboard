import express from "express";
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onRequestGet as portfolioHandler } from "./functions/api/portfolio.js";
import { onRequestGet as earningsHandler } from "./functions/api/earnings.js";
import { onRequestGet as marketHandler } from "./functions/api/market.js";
import { onRequestGet as benchmarkHandler } from "./functions/api/benchmark.js";
import { onRequestGet as fearGreedHandler } from "./functions/api/fear-greed.js";
import { onRequestGet as rebalanceHandler } from "./functions/api/rebalance.js";
import { loadStrategy, saveStrategy } from "./functions/api/lib/strategy-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

app.disable("x-powered-by");
// nginx 反代后 req.protocol/host 正确（earnings.js 拼绝对 URL 用）
app.set("trust proxy", true);

// —— Cloudflare Pages Function -> Express 适配层 ——
// functions/api/*.js 均导出 `onRequestGet({ env, request })` 并返回 `new Response(...)`，
// 这里把 Express 的 req 翻译成 CF 上下文，再把 Response 写回 res，API 逻辑只有一份。
function toExpress(handler) {
  return async (req, res) => {
    try {
      // earnings.js 内部 new URL(request.url) 读 searchParams，必须是绝对 URL
      const request = { url: `${req.protocol}://${req.get("host")}${req.originalUrl}` };
      const cfRes = await handler({ env: process.env, request });
      res.status(cfRes.status);
      for (const [key, value] of cfRes.headers.entries()) res.setHeader(key, value);
      const body = await cfRes.text();
      if (body) res.send(body); // Content-Type 已由 setHeader 设置，res.send 不会覆盖
      else res.end();
    } catch (error) {
      res.status(500).json({ error: "Internal Server Error", message: error.message });
    }
  };
}

// —— 路由（顺序：health -> API -> static -> 404） ——
app.get("/healthz", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get("/api/portfolio", toExpress(portfolioHandler));
app.get("/api/earnings", toExpress(earningsHandler));
app.get("/api/market", toExpress(marketHandler));
app.get("/api/benchmark", toExpress(benchmarkHandler));
app.get("/api/fear-greed", toExpress(fearGreedHandler));
app.get("/api/rebalance", toExpress(rebalanceHandler));
app.get("/api/strategy", (_req, res) => res.json(loadStrategy(process.env)));
app.put("/api/strategy", express.json({ limit: "32kb" }), (req, res) => {
  try {
    res.json(saveStrategy(req.body, process.env));
  } catch (error) {
    res.status(400).json({ error: "Invalid strategy", message: error.message });
  }
});

// —— 静态资源：默认 public, max-age=0 + ETag，不设长缓存（前端文件无版本 hash） ——
app.use(
  express.static(path.join(__dirname, "public"), {
    index: "index.html",
    dotfiles: "ignore",
  })
);

// API 兜底返回 JSON 404（而不是静态 HTML）
app.use("/api", (_req, res) => res.status(404).json({ error: "Not Found" }));
app.use((_req, res) => res.status(404).type("text/plain").send("Not Found"));

app.listen(PORT, HOST, () => {
  console.log(`[server] listening on http://${HOST}:${PORT} env=${process.env.NODE_ENV || "development"}`);
});
