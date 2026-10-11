// 钉钉群机器人发送器 —— 移植自 DSA（daily_stock_analysis）通知模块的 DingtalkSender。
//
// 群机器人 Webhook + 加签（HMAC-SHA256）。消息类型 markdown：钉钉 markdown
// 的 title 上限 20 字符、text 上限 20000 字节，超长按 19000 字节预算分批发送。
// 配置（env）：DINGTALK_WEBHOOK_URL / DINGTALK_SECRET（加签密钥）。
// 钉钉 API 海外可达（oapi.dingtalk.com），东京 VPS 无需代理。

import { createHmac } from "node:crypto";

const MAX_PAYLOAD_BYTES = 19000; // 预留 ~1000 字节给 JSON 结构 / 标题 / 分页后缀
const MAX_TITLE_CHARS = 20; // 钉钉 markdown title 官方上限
const TIMEOUT_MS = 10000;

function envValue(key, env = {}) {
  const value = env[key];
  return value === undefined ? "" : String(value).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 按字节预算切分长文本：优先在换行边界断开，单行超限才按字节硬切。
export function chunkByBytes(text, maxBytes = MAX_PAYLOAD_BYTES) {
  if (!text) return [];
  const budget = Math.max(1024, Number(maxBytes) || MAX_PAYLOAD_BYTES);
  if (Buffer.byteLength(text, "utf8") <= budget) return [text];

  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (Buffer.byteLength(candidate, "utf8") <= budget) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    // 单行仍超限：按字节硬切（保守二分收敛到边界）
    let rest = line;
    while (Buffer.byteLength(rest, "utf8") > budget) {
      let cut = Math.max(1, Math.floor(rest.length / 2));
      while (Buffer.byteLength(rest.slice(0, cut), "utf8") > budget) cut = Math.max(1, Math.floor(cut / 2));
      while (cut < rest.length && Buffer.byteLength(rest.slice(0, cut + 1), "utf8") <= budget) cut += 1;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  if (current) chunks.push(current);
  return chunks;
}

// 加签：timestamp + "\n" + secret → HMAC-SHA256 → base64 → URL 编码，拼到 webhook。
export function signedUrl(webhookUrl, secret) {
  if (!secret) return webhookUrl;
  const timestamp = String(Date.now());
  const sign = encodeURIComponent(
    createHmac("sha256", String(secret)).update(`${timestamp}\n${secret}`).digest("base64")
  );
  const sep = webhookUrl.includes("?") ? "&" : "?";
  return `${webhookUrl}${sep}timestamp=${timestamp}&sign=${sign}`;
}

/**
 * 发送 markdown 消息到钉钉群机器人。
 * @returns {Promise<{ok: boolean, errors?: string[]}>}
 */
export async function sendToDingtalk(content, title = "", env = {}) {
  const webhookUrl = envValue("DINGTALK_WEBHOOK_URL", env);
  if (!webhookUrl) {
    console.warn("[dingtalk] DINGTALK_WEBHOOK_URL 未配置，跳过推送");
    return { ok: false, errors: ["DINGTALK_WEBHOOK_URL not configured"] };
  }

  const secret = envValue("DINGTALK_SECRET", env);
  const url = signedUrl(webhookUrl, secret);
  const safeTitle = (title || "").slice(0, MAX_TITLE_CHARS);
  const chunks = chunkByBytes(content);
  const results = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const text = index === 0 && safeTitle ? `### ${safeTitle}\n\n${chunk}` : chunk;
    const displayTitle =
      chunks.length > 1 ? `${safeTitle || "通知"} (${index + 1}/${chunks.length})` : safeTitle || "通知";
    const payload = { msgtype: "markdown", markdown: { title: displayTitle.slice(0, MAX_TITLE_CHARS), text } };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.errcode === 0) {
        results.push({ ok: true });
      } else {
        const error = body.errmsg || `HTTP ${response.status}`;
        results.push({ ok: false, error });
        console.error(`[dingtalk] 分段 ${index + 1}/${chunks.length} 发送失败: ${error}`);
      }
    } catch (error) {
      results.push({ ok: false, error: error.message });
      console.error(`[dingtalk] 分段 ${index + 1}/${chunks.length} 异常: ${error.message}`);
    }

    if (chunks.length > 1 && index < chunks.length - 1) await sleep(500);
  }

  const failures = results.filter((result) => !result.ok);
  return { ok: failures.length === 0, errors: failures.map((result) => result.error) };
}
