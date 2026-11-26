/**
 * host-bridge —— 与千问办公(QwenWork)桌面端进程内模型代理的对接层。
 *
 * 千问办公启动引擎会话时，会在 launch-config.json 里写入一份 provider 配置：
 *   provider.<name>.options.baseURL  -> http://127.0.0.1:<port>/v1   （宿主进程内模型代理）
 *   provider.<name>.options.apiKey   -> 该会话专属的「本地路由 token」
 *   provider.<name>.models           -> 该会话在目录里可见的模型
 *
 * 宿主进程内的代理(InProcessLocalModelProxy)按 Authorization 头里的本地 token
 * 选中路由，再把请求转发到公网 MaaS 网关(https://maas.xiaoluozi.cn/v1)。
 * 路由存在 ≠ 可用：只有在宿主为该会话登记了活跃 turn 时才返回 200，
 * 否则返回 409 TURN_CONTEXT_MISSING。
 *
 * 因此这里的职责是：发现候选路由 → 探测哪条路由当前可用 → 转发请求。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HARNESS_ROOT = path.join(os.homedir(), ".qwenworkcn/.harness/flash-cli/config");

/** 读取所有会话的 launch-config，提取可用的本地路由候选。 */
export function listRouteCandidates() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(HARNESS_ROOT);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const lc = path.join(HARNESS_ROOT, dir, "launch-config");
    let files = [];
    try {
      files = fs.readdirSync(lc);
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(lc, f);
      try {
        const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const [providerName, pv] of Object.entries(cfg.provider || {})) {
          const opts = pv.options || {};
          if (!opts.baseURL || !opts.apiKey) continue;
          if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(opts.baseURL)) continue;
          out.push({
            session: dir,
            file: p,
            mtime: fs.statSync(p).mtimeMs,
            provider: providerName,
            npm: pv.npm || null,
            baseURL: opts.baseURL,
            token: opts.apiKey,
            catalogModels: Object.keys(pv.models || {}),
            sessionModel: cfg.model || null,
            smallModel: cfg.small_model || null,
          });
        }
      } catch {
        /* 忽略损坏的配置文件 */
      }
    }
  }
  // 同一会话的多个 provider 指向同一个端口，按 mtime 倒序（最近的先试）
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * 探测一条路由是否「活跃」（存在 turn 上下文）。
 * 用空 body POST：不会真的消耗 token，返回 400 说明路由与 turn 都在，409 说明无活跃 turn。
 */
async function probeRoute(candidate) {
  try {
    const res = await fetch(candidate.baseURL.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${candidate.token}` },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    });
    const text = await res.text();
    if (res.status === 404) return { live: false, reason: "route_not_found", detail: text.slice(0, 120) };
    if (res.status === 409) return { live: false, reason: "turn_context_missing", detail: text.slice(0, 120) };
    // 400/422/200/401 都说明「路由存在且已挂上 turn」，具体鉴权失败交给真实请求处理
    return { live: true, reason: "ok", status: res.status, detail: text.slice(0, 120) };
  } catch (e) {
    return { live: false, reason: "unreachable", detail: e.message };
  }
}

/**
 * 直连 MaaS 通道：用宿主自己的 accessKey 直接打网关，绕开进程内代理。
 *
 * 相比宿主代理，直连有两个决定性优势：
 *   1. 不受「宿主必须有活跃 turn」的限制（代理在 turn 结束时会回 409）；
 *   2. 不依赖宿主进程内的随机端口，桌面端重启/换端口都不影响。
 * 代价是 accessKey 有 TTL（通常 2 小时），由桌面端续期后落盘，网关定期重读即可。
 */
export function resolveDirectRoute(credStore) {
  if (!credStore) return null;
  const live = credStore.live();
  if (!live.length) return null;
  const best = live[0];
  return {
    session: best.sessionId,
    provider: "maas-direct",
    baseURL: best.baseUrl,
    token: best.accessKey,
    catalogModels: [],
    sessionModel: null,
    source: "direct",
    expiresAtMs: best.expiresAtMs,
    alternatives: live.slice(1),
  };
}

/**
 * 找到一条当前可用的路由。
 * 优先级：显式环境变量 > 直连凭证 > 宿主进程内代理。
 * env 显式配置不做 turn 探测（用于无头模式：直连自己的 MaaS key 或固定代理）。
 */
export function resolveExplicitRoute() {
  const baseURL = process.env.QWENWORK_PROXY_BASE_URL;
  const token = process.env.QWENWORK_PROXY_TOKEN;
  if (!baseURL || !token) return null;
  return {
    session: "env",
    provider: "explicit",
    baseURL: baseURL.replace(/\/+$/, "") + (baseURL.endsWith("/v1") ? "" : "/v1"),
    token,
    catalogModels: [],
    sessionModel: null,
    source: "env",
  };
}

export class HostBridge {
  constructor({ ttlMs = 8000, credStore = null } = {}) {
    this.ttlMs = ttlMs;
    this.credStore = credStore;
    this.cached = null;
    this.cachedAt = 0;
    this.lastProbe = null;
    this.lastMode = null;
  }

  /** 返回 { route, candidates, probe }；route 为 null 表示当前没有可用路由。 */
  async resolve({ force = false } = {}) {
    const explicit = resolveExplicitRoute();
    if (explicit) return { route: explicit, candidates: [], probe: { live: true, reason: "explicit" }, mode: "env" };

    // 直连凭证优先：不受活跃 turn 限制，也不依赖宿主端口。
    const direct = resolveDirectRoute(this.credStore);
    if (direct) {
      this.cached = direct;
      this.cachedAt = Date.now();
      this.lastProbe = [{ mode: "direct", live: true, reason: "credential", session: direct.session, expiresAtMs: direct.expiresAtMs }];
      return { route: direct, candidates: [], probe: this.lastProbe, mode: "direct" };
    }

    const now = Date.now();
    if (!force && this.cached && now - this.cachedAt < this.ttlMs) {
      return { route: this.cached, candidates: [], probe: this.lastProbe, cached: true, mode: this.lastMode };
    }

    const candidates = listRouteCandidates();
    const probe = [];
    let route = null;
    for (const c of candidates) {
      const r = await probeRoute(c);
      probe.push({ session: c.session, provider: c.provider, ...r });
      if (r.live && !route) {
        route = c;
        break;
      }
    }
    this.cached = route;
    this.cachedAt = now;
    this.lastProbe = probe;
    this.lastMode = "proxy";
    return { route, candidates, probe, mode: "proxy" };
  }

  /**
   * 直连模式下 key 失效（401/403）时换一把备用 key 重试。
   * 返回新的 route，或 null 表示没有备用了。
   */
  rotate(route) {
    if (!route || route.source !== "direct") return null;
    const alts = route.alternatives || [];
    if (!alts.length) return null;
    const next = alts[0];
    return {
      ...route,
      session: next.sessionId,
      baseURL: next.baseUrl,
      token: next.accessKey,
      expiresAtMs: next.expiresAtMs,
      alternatives: alts.slice(1),
    };
  }

  /** 把 OpenAI 请求体转发到宿主代理，透传流式与非流式。 */
  async forward(route, body, { signal } = {}) {
    const url = route.baseURL.replace(/\/+$/, "") + "/chat/completions";
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${route.token}` },
      body: JSON.stringify(body),
      signal,
    });
  }
}
