#!/usr/bin/env node
/**
 * keepalive —— 凭证保活：定期用当前 accessKey 向 MaaS 发一个最小请求，
 * 让上游会话保持活跃，桌面端据此持续续期 accessKey（TTL 通常 2 小时）。
 *
 * 背景：accessKey 按会话签发，只有会话有活动才会续期。客户端光开着、
 * 长时间不说话，key 照样过期，网关就会返回 503 no_live_route。
 * 本脚本由 LaunchAgent 每 90 分钟跑一次，替代「去界面里说句话」的手动动作。
 *
 * 行为：
 *   - 读 ~/.qwenworkcn/engine-maas-key.dat（复用 lib/credential.mjs，key 不落盘不打印）；
 *   - 对每把未过期的 key 发 1 token 的 ping（默认模型 lite，最便宜的非推理档）；
 *   - 没有活 key 时：若千问办公客户端在运行则等待其续期（退出码 2），
 *     否则尝试拉起客户端（open -ga，后台不抢焦点），再等一轮（退出码 3）。
 *
 * 用法：node scripts/keepalive.mjs [--model lite] [--verbose]
 * 退出码：0=至少一把 key ping 成功；2=无活 key（客户端在运行）；3=无活 key（已尝试拉起客户端）；1=其他错误。
 */
import { execFileSync } from "node:child_process";
import { CredentialStore } from "../lib/credential.mjs";

const args = process.argv.slice(2);
const modelIdx = args.indexOf("--model");
const MODEL = modelIdx >= 0 && args[modelIdx + 1] ? args[modelIdx + 1] : process.env.KEEPALIVE_MODEL || "lite";
const VERBOSE = args.includes("--verbose");
const APP_NAME = process.env.QWENWORK_APP_NAME || "QwenWorkCN";
const PING_TIMEOUT_MS = Number(process.env.KEEPALIVE_TIMEOUT_MS || 30000);

const log = (...a) => console.log(new Date().toISOString(), ...a);

function clientRunning() {
  try {
    execFileSync("pgrep", ["-x", APP_NAME], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

async function ping(cred) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(cred.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cred.accessKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (res.ok) return { ok: true, status: res.status };
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text)?.error?.message || msg; } catch { /* 非 JSON 原样 */ }
    return { ok: false, status: res.status, message: msg };
  } catch (e) {
    return { ok: false, status: 0, message: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

const store = new CredentialStore();
const snap = store.get({ force: true });
if (!snap.ok) {
  log(`credential unavailable: ${snap.reason}`);
  process.exit(1);
}

const live = store.live({ force: true });
const now = Date.now();
if (VERBOSE) {
  for (const c of snap.credentials) {
    log(`session=${c.sessionId.slice(0, 8)}… remaining=${Math.round((c.expiresAtMs - now) / 60000)}min`);
  }
}

if (!live.length) {
  if (clientRunning()) {
    log("no live credential; client is running, waiting for its next mint");
    process.exit(2);
  }
  log(`no live credential and ${APP_NAME} not running; launching it in background`);
  try {
    execFileSync("open", ["-ga", APP_NAME], { stdio: "ignore" });
  } catch (e) {
    log(`failed to launch ${APP_NAME}: ${e.message}`);
    process.exit(1);
  }
  process.exit(3);
}

let successes = 0;
for (const cred of live) {
  const r = await ping(cred);
  const sid = cred.sessionId.slice(0, 8) + "…";
  if (r.ok) {
    successes++;
    log(`ping ok session=${sid} model=${MODEL} remaining=${Math.round((cred.expiresAtMs - Date.now()) / 60000)}min`);
  } else {
    log(`ping FAILED session=${sid} status=${r.status} ${r.message || ""}`);
  }
}

process.exit(successes > 0 ? 0 : 1);