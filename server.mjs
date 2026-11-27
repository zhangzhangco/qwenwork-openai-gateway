#!/usr/bin/env node
/**
 * qwenwork-openai-gateway
 *
 * 把「千问办公」的模型调用能力包装成标准 OpenAI API：
 *   GET  /v1/models            -> OpenAI 模型列表
 *   POST /v1/chat/completions  -> OpenAI 对话补全（支持 stream / 非流式、tools 透传）
 *   POST /v1/messages          -> Anthropic Messages 形状的透传（给 Anthropic SDK 用）
 *   GET  /health               -> 网关与宿主连通性状态
 *
 * 上游：千问办公桌面端进程内的模型代理（默认自动发现），或用环境变量指定任意 OpenAI 兼容上游。
 */
import http from "node:http";
import { HostBridge } from "./lib/host-bridge.mjs";
import { CredentialStore } from "./lib/credential.mjs";
import { loadRegistry, toOpenAIList } from "./lib/registry.mjs";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || "";
const credStore = new CredentialStore({ ttlMs: Number(process.env.CREDENTIAL_TTL_MS || 30000) });
const bridge = new HostBridge({ ttlMs: Number(process.env.ROUTE_TTL_MS || 8000), credStore });

function cors(res) {
  res.setHeader("access-control-allow-origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-api-key");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, status, message, { type = "invalid_request_error", code = null, param = null } = {}) {
  sendJSON(res, status, { error: { message, type, param, code } });
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clientAuthorized(req) {
  if (!GATEWAY_API_KEY) return true;
  const h = req.headers.authorization || "";
  const xk = req.headers["x-api-key"] || "";
  return h === `Bearer ${GATEWAY_API_KEY}` || xk === GATEWAY_API_KEY;
}

/** 把上游的错误响应转成 OpenAI 错误形状。 */
async function relayError(upstream, res) {
  const text = await upstream.text().catch(() => "");
  let message = text.slice(0, 500) || `upstream ${upstream.status}`;
  let type = "invalid_request_error";
  let code = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error) {
      message = parsed.error.message || message;
      type = parsed.error.type || type;
      code = parsed.error.code ?? null;
    }
  } catch {
    /* 非 JSON 原样透传 */
  }
  sendError(res, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502, message, { type, code });
}

async function handleChatCompletions(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return sendError(res, 400, `invalid JSON body: ${e.message}`);
  }
  if (!payload || typeof payload !== "object") return sendError(res, 400, "body must be a JSON object");
  if (!payload.model) return sendError(res, 400, "missing required parameter: 'model'", { param: "model" });
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return sendError(res, 400, "missing required parameter: 'messages'", { param: "messages" });
  }

  let { route, mode } = await bridge.resolve();
  if (!route) {
    const snap = credStore.get();
    return sendError(
      res,
      503,
      "no live 千问办公 route: 拿不到可用的上游通道。" +
        (snap.ok ? "" : ` 宿主凭证不可用(${snap.reason})。`) +
        " 请保持千问办公客户端在运行（它会签发/续期 accessKey），" +
        " 或设置 QWENWORK_PROXY_BASE_URL / QWENWORK_PROXY_TOKEN 指向可用的 OpenAI 兼容上游。",
      { type: "server_error", code: "no_live_route" },
    );
  }

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  let upstream = await bridge.forward(route, payload, { signal: controller.signal }).catch((e) => {
    sendError(res, 502, `failed to reach host proxy: ${e.message}`, { type: "server_error" });
    return null;
  });
  if (!upstream) return;

  // 直连模式下 accessKey 过期/失效：换一把备用 key 重试
  if ((upstream.status === 401 || upstream.status === 403) && route.source === "direct") {
    await upstream.text().catch(() => "");
    const rotated = bridge.rotate(route);
    if (rotated) {
      route = rotated;
      upstream = await bridge.forward(route, payload, { signal: controller.signal }).catch(() => null);
      if (!upstream) return sendError(res, 502, "failed to reach maas after credential rotation", { type: "server_error" });
    }
  }

  // 宿主代理模式：路由可能刚好失效（turn 结束）：强制重新发现一次再重试
  if (upstream.status === 409 && route.source !== "direct") {
    await upstream.text().catch(() => "");
    const retry = await bridge.resolve({ force: true });
    if (retry.route && retry.route.session !== route.session) {
      route = retry.route;
      upstream = await bridge.forward(route, payload, { signal: controller.signal }).catch(() => null);
      if (!upstream) return sendError(res, 502, "failed to reach host proxy on retry", { type: "server_error" });
    }
    if (upstream.status === 409) {
      await upstream.text().catch(() => "");
      return sendError(
        res,
        503,
        "host turn context is gone (409 TURN_CONTEXT_MISSING): 千问办公当前会话已结束，模型通道不可用。",
        { type: "server_error", code: "turn_context_missing" },
      );
    }
  }

  if (!upstream.ok) return relayError(upstream, res);

  if (payload.stream) {
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((r) => res.once("drain", r));
        }
      }
    } catch (e) {
      if (!res.headersSent) sendError(res, 502, `stream aborted: ${e.message}`);
    } finally {
      res.end();
      reader.cancel().catch(() => {});
    }
    return;
  }

  const text = await upstream.text();
  res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function handleMessages(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return sendError(res, 400, `invalid JSON body: ${e.message}`);
  }
  if (!payload?.model) return sendError(res, 400, "missing required parameter: 'model'", { param: "model" });

  const { route } = await bridge.resolve();
  if (!route) return sendError(res, 503, "no live 千问办公 route", { type: "server_error", code: "no_live_route" });

  const controller = new AbortController();
  req.on("close", () => controller.abort());
  let upstream = await fetch(route.baseURL.replace(/\/+$/, "") + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${route.token}` },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).catch((e) => {
    sendError(res, 502, `failed to reach host proxy: ${e.message}`, { type: "server_error" });
    return null;
  });
  if (!upstream) return;

  if ((upstream.status === 401 || upstream.status === 403) && route.source === "direct") {
    await upstream.text().catch(() => "");
    const rotated = bridge.rotate(route);
    if (rotated) {
      upstream = await fetch(rotated.baseURL.replace(/\/+$/, "") + "/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${rotated.token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => null);
      if (!upstream) return sendError(res, 502, "failed to reach maas after credential rotation", { type: "server_error" });
    }
  }

  if (!upstream.ok) return relayError(upstream, res);
  if (payload.stream) {
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } finally {
      res.end();
      reader.cancel().catch(() => {});
    }
    return;
  }
  const text = await upstream.text();
  res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function handleHealth(res) {
  const { route, probe, mode } = await bridge.resolve({ force: true });
  const snap = credStore.get({ force: true });
  const now = Date.now();
  const live = snap.credentials.filter((c) => !c.expiresAtMs || c.expiresAtMs > now);
  sendJSON(res, 200, {
    status: route ? "ok" : "degraded",
    gateway: { port: PORT, model_count: loadRegistry().length, client_auth: GATEWAY_API_KEY ? "required" : "disabled" },
    mode: mode || (route ? route.source : null),
    host: route
      ? {
          connected: true,
          session: route.session,
          provider: route.provider,
          base_url: route.baseURL,
          session_model: route.sessionModel,
          catalog_models: route.catalogModels,
        }
      : { connected: false, hint: "启动千问办公客户端（它会签发/续期 accessKey），或设置 QWENWORK_PROXY_BASE_URL / QWENWORK_PROXY_TOKEN" },
    credential: {
      available: snap.ok,
      reason: snap.reason || null,
      live_count: live.length,
      total_count: snap.credentials.length,
      next_expiry: live[0]?.expiresAtMs || null,
      remaining_min: live[0] ? Math.round((live[0].expiresAtMs - now) / 60000) : null,
    },
    probe,
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  if (!clientAuthorized(req)) {
    return sendError(res, 401, "incorrect API key provided", { type: "invalid_request_error", code: "invalid_api_key" });
  }

  try {
    if (req.method === "GET" && (p === "/v1/models" || p === "/models")) {
      if (url.searchParams.get("verbose") === "1") {
        return sendJSON(res, 200, { object: "list", data: loadRegistry() });
      }
      return sendJSON(res, 200, toOpenAIList());
    }
    if (req.method === "GET" && (p === "/health" || p === "/")) {
      return handleHealth(res);
    }
    if (req.method === "POST" && (p === "/v1/chat/completions" || p === "/chat/completions")) {
      return handleChatCompletions(req, res);
    }
    if (req.method === "POST" && (p === "/v1/messages" || p === "/messages")) {
      return handleMessages(req, res);
    }
    return sendError(res, 404, `unknown endpoint: ${req.method} ${p}`, { code: "not_found" });
  } catch (e) {
    if (!res.headersSent) sendError(res, 500, `internal error: ${e.message}`, { type: "server_error" });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`qwenwork-openai-gateway listening on http://${HOST}:${PORT}`);
  console.log(`  GET  http://${HOST}:${PORT}/v1/models`);
  console.log(`  POST http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`  client auth: ${GATEWAY_API_KEY ? "enabled (GATEWAY_API_KEY)" : "disabled"}`);
});
