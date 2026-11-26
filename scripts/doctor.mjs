#!/usr/bin/env node
/**
 * doctor —— 环境自检：确认网关能否拿到一条「活的」千问办公模型通道。
 * 用法：node scripts/doctor.mjs [可选的模型名]
 */
import { HostBridge, listRouteCandidates } from "../lib/host-bridge.mjs";
import { CredentialStore } from "../lib/credential.mjs";
import { loadRegistry } from "../lib/registry.mjs";

const credStore = new CredentialStore();
const bridge = new HostBridge({ credStore });
const model = process.argv[2] || loadRegistry().find((m) => m.verified)?.id || "minimax-m3.1-flash";

console.log("node:", process.version);
console.log("registry models:", loadRegistry().length);

const snap = credStore.get({ force: true });
const now = Date.now();
console.log(`credential: available=${snap.ok} reason=${snap.reason || "-"} entries=${snap.credentials.length}`);
for (const c of snap.credentials) {
  const mins = c.expiresAtMs ? Math.round((c.expiresAtMs - now) / 60000) : null;
  console.log(`  - session=${c.sessionId.slice(0, 8)}… base=${c.baseUrl} expires_in=${mins}min ${c.expiresAtMs <= now ? "(expired)" : ""}`);
}

const candidates = listRouteCandidates();
console.log("host proxy candidates:", candidates.length);
for (const c of candidates) {
  console.log(`  - session=${c.session} provider=${c.provider} base=${c.baseURL} models=[${c.catalogModels.join(",")}]`);
}

const { route, probe, mode } = await bridge.resolve({ force: true });
console.log("\nprobe:");
for (const p of probe) {
  console.log(`  - session=${p.session} provider=${p.provider} live=${p.live} reason=${p.reason}${p.detail ? " " + p.detail : ""}`);
}

if (!route) {
  console.error("\n✗ 没有可用通道。请启动千问办公客户端（它会签发/续期 accessKey），或设置 QWENWORK_PROXY_BASE_URL / QWENWORK_PROXY_TOKEN。");
  process.exit(1);
}

console.log(`\n→ 使用通道 mode=${mode} session=${route.session} provider=${route.provider} base=${route.baseURL}`);
const res = await bridge.forward(route, {
  model,
  messages: [{ role: "user", content: "回复两个字：ok" }],
  max_tokens: 32,
});
const text = await res.text();
console.log(`→ ${model} HTTP ${res.status}`);
console.log(`→ ${text.slice(0, 400)}`);
process.exit(res.ok ? 0 : 1);
