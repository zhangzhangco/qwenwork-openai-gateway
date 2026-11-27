#!/usr/bin/env node
/**
 * keepalive —— 凭证保活：定期用当前 accessKey 调 MaaS 的 token exchange 接口
 * 轮换出一把新 key（TTL 重新计满），写入网关自己的私有缓存，从此不再依赖
 * 桌面端「有会话活动才续期」的行为。
 *
 * 背景：accessKey 按会话签发（TTL 约 2 小时），桌面端只在引擎请求前才续期；
 * 客户端光开着、长时间不说话，key 照样过期，网关回 503 no_live_route。
 * 实测直接打 MaaS 聊天接口**不会**触发桌面端续期，但
 *   POST {base}/v1/access-tokens/exchange  (Bearer 旧key, body {ttl_ms})
 * 会返回一把全新的 key（201），且旧 key 在自然过期前仍然有效（平滑轮换）。
 *
 * 行为：
 *   - 候选 key 来源：网关私有缓存（~/.qwenworkcn/gateway-keepalive-key.json，0600）
 *     + 宿主凭证文件（复用 lib/credential.mjs）；取剩余有效期最长且未过期的一把；
 *   - 对候选 key 调 exchange 换新 key，新 key 只写私有缓存（0600），不打印；
 *   - 可选 --ping：用新 key 发 1 token 最小请求验证通道（默认模型 lite）；
 *   - 无活 key 时：客户端在运行则等它 mint（退出码 2）；否则后台拉起客户端（退出码 3）。
 *
 * 用法：node scripts/keepalive.mjs [--ping] [--model lite] [--verbose]
 * 退出码：0=轮换成功；2=无活 key（客户端在运行）；3=无活 key（已尝试拉起客户端）；1=其他错误。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CredentialStore } from "../lib/credential.mjs";

const args = process.argv.slice(2);
const modelIdx = args.indexOf("--model");
const MODEL = modelIdx >= 0 && args[modelIdx + 1] ? args[modelIdx + 1] : process.env.KEEPALIVE_MODEL || "lite";
const VERBOSE = args.includes("--verbose");
const DO_PING = args.includes("--ping");
const APP_NAME = process.env.QWENWORK_APP_NAME || "QwenWorkCN";
const TIMEOUT_MS = Number(process.env.KEEPALIVE_TIMEOUT_MS || 30000);
const CACHE_FILE =
  process.env.QWENWORK_KEEPALIVE_CACHE || path.join(os.homedir(), ".qwenworkcn", "gateway-keepalive-key.json");

const log = (...a) => console.log(new Date().toISOString(), ...a);

function clientRunning() {
  try {
    execFileSync("pgrep", ["-x", APP_NAME], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (c.accessKey && c.baseUrl && c.expiresAtMs) return c;
  } catch { /* 无缓存或损坏 */ }
  return null;
}

function saveCache(cred) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true, mode: 0o700 });
  const tmp = CACHE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cred), { mode: 0o600 });
  fs.renameSync(tmp, CACHE_FILE);
}

async function fetchJSON(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  } catch (e) {
    return { status: 0, ok: false, json: null, text: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 用旧 key 换一把新 key（MaaS 官方轮换接口，宿主同款）。 */
async function exchange(cred) {
  const base = cred.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const r = await fetchJSON(base + "/v1/access-tokens/exchange", {
    method: "POST",
    headers: { Authorization: `Bearer ${cred.accessKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ttl_ms: cred.ttlMs || 7200000 }),
  });
  if (!r.ok || typeof r.json?.access_token !== "string" || !r.json.access_token || !(r.json.expires_at > 0)) {
    return { ok: false, status: r.status, message: r.json?.error?.message || r.text.slice(0, 160) };
  }
  return {
    ok: true,
    credential: {
      accessKey: r.json.access_token,
      baseUrl: cred.baseUrl,
      expiresAtMs: r.json.expires_at,
      ttlMs: cred.ttlMs || 7200000,
      sessionId: cred.sessionId || null,
      source: "keepalive-exchange",
      rotatedAt: Date.now(),
    },
  };
}

async function ping(cred) {
  const r = await fetchJSON(cred.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cred.accessKey}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
  });
  return r.ok ? { ok: true } : { ok: false, status: r.status, message: r.json?.error?.message || r.text.slice(0, 160) };
}

// ---- 收集候选 key：私有缓存 + 宿主凭证文件，取未过期且剩余最长的一把 ----
const now = Date.now();
const candidates = [];
const cached = loadCache();
if (cached) candidates.push(cached);
const store = new CredentialStore();
const snap = store.get({ force: true });
if (snap.ok) {
  for (const c of snap.credentials) candidates.push({ ...c, source: "host-file" });
} else if (!cached) {
  log(`credential unavailable: ${snap.reason}`);
  process.exit(1);
}
const live = candidates.filter((c) => c.expiresAtMs > now).sort((a, b) => b.expiresAtMs - a.expiresAtMs);
if (VERBOSE) {
  for (const c of candidates) {
    log(`candidate source=${c.source || "?"} remaining=${Math.round((c.expiresAtMs - now) / 60000)}min`);
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

// ---- 依次尝试轮换（第一把失败就试下一把，容忍旧 key 被上游提前作废） ----
let rotated = null;
for (const cand of live) {
  const r = await exchange(cand);
  if (r.ok) { rotated = r.credential; break; }
  log(`exchange failed source=${cand.source || "?"} status=${r.status} ${r.message || ""}`);
}
if (!rotated) {
  log("all exchange attempts failed; keeping existing credentials");
  process.exit(1);
}

saveCache(rotated);
log(`rotated ok expires=${new Date(rotated.expiresAtMs).toLocaleString("zh-CN")} remaining=${Math.round((rotated.expiresAtMs - Date.now()) / 60000)}min cache=${CACHE_FILE}`);

if (DO_PING) {
  const p = await ping(rotated);
  if (p.ok) log(`ping ok model=${MODEL}`);
  else { log(`ping FAILED status=${p.status} ${p.message || ""}`); process.exit(1); }
}

process.exit(0);