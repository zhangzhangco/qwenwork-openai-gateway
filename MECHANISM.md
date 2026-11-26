# 千问办公是如何调用不同模型的

> 本文结论来自对本机 `QwenWorkCN.app` 2.1.0（千问办公 / QwenWork CN）的静态代码分析 + 运行时实测。
> 涉及的关键实现都在 `app.asar`（打包后的主进程代码）与 `agent-sdk/`（引擎 SDK）里，文中给出定位线索。

---

## 1. 一句话结论

千问办公**不直接**把请求打到模型厂商。它自己维护一条 **「模型目录 → 协议映射 → MaaS 网关 → 厂商模型」** 的链路：

```
客户端(引擎/IDE/CLI)
   │  Authorization: Bearer <会话本地路由 token>
   ▼
127.0.0.1:<随机端口>/v1/{chat/completions | responses | messages}     ← 宿主进程内模型代理 InProcessLocalModelProxy
   │  x-qwenwork-acg-token: Bearer <JWT>
   │  x-qwenwork-provider-token: <MaaS accessKey>
   │  x-qwenwork-session-token: asi1.pcs.<...>
   ▼
https://maas.xiaoluozi.cn/v1/...                                      ← 公网 MaaS 网关（默认常量）
   ▼
Qwen / GLM / Kimi / DeepSeek / MiniMax / Step 等具体模型
```

**选模型 = 改请求体里的 `model` 字段**；模型 id 来自服务端下发的「模型目录」，协议形态由目录里的 provider 决定。

但这条路**不是唯一入口**：宿主签发的凭证里自带一个 `baseUrl`，拿着那把 accessKey 可以**绕过上面整条代理链路直连网关**（见第 4 节）。

---

## 2. 三层：目录 → 协议 → 网关

### 2.1 模型目录（catalog）

- 目录名 `chat-modes-v2`，缓存在 `~/Library/Application Support/QwenWorkCN/data/model-catalog/chat-modes-v2/*.lkg`（**加密**，safeStorage + 自定义头）。
- 目录是**服务端下发**的：渲染层 schema 里能看到 `catalogSource` / `catalog.hideBuiltin` 等字段（`app.asar` 中 `models.catalogSource`）。
- 运行时策略有三套（`app.asar` 中 `runtimeServicesExtension`）：
  | 策略 | 模型目录来源 | 说明 |
  |---|---|---|
  | `managed-maas` | 服务端 | 宿主直接托管 MaaS |
  | `managed-opencode` | `chat-modes-v2` | OpenCode 引擎 + 本地目录缓存 |
  | `qodercli` | `qodercli` | QoderCLI 引擎 |
- 每个目录项形如 `{ id, provider, protocol, contextWindow, maxOutputTokens, modalities }`，并带 `reasoning`/`tool_call`/`temperature` 等能力位。

### 2.2 协议映射（wire protocol）

`app.asar` 里 `resolveOpencodeModelProtocol()` 的规则：

| provider | wire protocol | 实际请求路径 |
|---|---|---|
| `anthropic` | `anthropic-messages` | `{base}/messages` |
| `openai` | `openai-responses` | `{base}/responses` |
| 其它 / 未知 | `openai-chat` | `{base}/chat/completions` |

未知 provider 会落到 `@ai-sdk/openai-compatible`（兜底声明在 `resolveOpencodeProviderKind` 附近，注释即写着 *"unknown model for opencode provider mapping, defaulting to openai-compatible"*）。

> 注意：千问办公把 **MiniMax 挂在 `anthropic` provider 下**——本机启动配置里就是
> `provider.anthropic.models = { "minimax-m3.1-flash": ... }`，协议走 Anthropic Messages 形状，但模型本身是 MiniMax。

### 2.3 网关（transport）

`agent-sdk` 与主进程代码里定义：

```js
const DEFAULT_MAAS_BASE_URL = "https://maas.xiaoluozi.cn";
getEngineMaasApiBaseUrl() => base.endsWith("/v1") ? base : base + "/v1"
```

可用环境变量覆盖：`ENGINE_MAAS_BASE_URL`（网关）、`ENGINE_MAAS_MINT_URL` / `ENGINE_MAAS_MINT_STACK`（签发地址）、`QODER_DEV_ACCESS_TOKEN`（开发态 token）。

实测：`POST https://maas.xiaoluozi.cn/v1/chat/completions` 返回
`401 {"error":{"code":"unauthorized","message":"unauthorized: missing Authorization header"}}`，
`/v1/responses`、`/v1/messages` 同样存在并返回 401 → **网关本身是 OpenAI 兼容的**，三种协议都在同一 base 下。

> ⚠️ 但**实际签发出来的凭证指向的不是这个默认地址**，而是 `https://api9.qwenwork.cn/v1`（见 3.2）。

---

## 3. 鉴权链

### 3.1 代理路径上的上游三件套

主进程的网关客户端（`app.asar` 中 `startGatewayHttpOAuth` 一段）向上游注入三个 header：

| header | 形态 | 来源 |
|---|---|---|
| `x-qwenwork-acg-token` | `Bearer <JWT>` | 登录态派生的 QwenWork JWT |
| `x-qwenwork-provider-token` | base64url 串 | MaaS provider token |
| `x-qwenwork-session-token` | `asi1.pcs.<...>` | `agentAuthService.getSessionToken({chatId, subChatId, sessionId})` |

校验逻辑在代码里很直白：`agentSessionIdentity` 必须以 `asi1.pcs.` 开头且不含空格；ACG 头必须匹配 `/^Bearer [^\s,]+$/i`。

代理转发时会**把客户端头里的本地 token 替换成真实 token**（`buildUpstreamHeaders` 里的 `l.split(i).join(r.token)`，`i` 是 64 位 hex 本地 token），
所以外部拿本地 token 当 bearer 直连上游会被判 `unrecognized bearer scheme`。

### 3.2 MaaS accessKey 的签发、缓存与解密 ← 关键

- 签发：`POST {业务网关}/api/desktop-sessions`，body `{"session_id":"..."}`，路径常量 `MAAS_MINT_PATH="/api/desktop-sessions"`。
- 凭证对象：`{ accessKey, expiresAtMs, ttlMs, baseUrl, maasSessionId }`。
- 缓存：`~/.qwenworkcn/engine-maas-key.dat`。

**文件格式（已完全解出）**：

```
"v10" | iv(16) | AES-128-CBC(密文)
密钥 = PBKDF2-HMAC-SHA1(登录钥匙串密码, "saltysalt", 1003, 16)
钥匙串项 = "QwenWorkCN Safe Storage"   ← service 名 = <应用名> + " Safe Storage"
```

> 解密细节：Chromium OSCrypt 的派生参数是 **1003 次**（不是 1000）、**SHA1**、**16 字节 key**、AES-128-CBC。
> 密文解出来后是一段 JSON，**前 10 个字符 `{"version` 不在密文里**（宿主把这截留在明文区），
> 所以拼回时要补上：`JSON.parse('{"version"' + plain)`。

解密后的内容形如：

```json
{
  "version": 2,
  "identityFingerprint": "<16 位 hex 指纹>",
  "credentials": {
    "<sessionId>": {
      "accessKey": "sk-mm-v1.<...>",
      "expiresAtMs": <毫秒时间戳>,
      "ttlMs": 7200000,
      "baseUrl": "https://api9.qwenwork.cn/v1",
      "maasSessionId": "<sessionId>"
    }
  }
}
```

> ⚠️ **这套解密的前提是「本机该用户的登录身份」**——必须能读登录钥匙串。
> 它**不构成远程风险**：没有任何可访问的端点，能执行 `security find-generic-password` 的人本来就已经是该用户。
> 但它意味着本机一旦被攻破，凭证可被**静默提取**并绕过桌面端界面使用，所以访问控制要以「机器被拿下 = 账号被拿下」来评估。

要点：
- `baseUrl` 是**签发时随凭证一起下发**的，本机实测是 `https://api9.qwenwork.cn/v1`（不是 2.3 里的默认常量）。
- `accessKey` 形如 `sk-mm-v1.*`，`ttlMs = 7200000`（2 小时），由桌面端自动续期后重新落盘。
- 一个文件里可能有**多个 session** 的凭证，各自独立计时。

**直连实测**（只用 `Authorization: Bearer <accessKey>`，不带任何额外 header）：

| 请求 | 结果 |
|---|---|
| `POST {baseUrl}/chat/completions` | 200，标准 OpenAI 形状响应（含 `reasoning_content`） |
| 同上 `stream:true` | 200，`text/event-stream`，标准 `chat.completion.chunk` + `[DONE]` |
| `POST {baseUrl}/messages` | 200，Anthropic 形状（`content[].text` / `.thinking`） |
| `POST {baseUrl}/chat/completions` 带 `tools` | 200，`finish_reason=tool_calls`，标准 `tool_calls[]` |
| `GET {baseUrl}/models` | 404 → **上游没有模型列表接口**，模型清单要自己维护 |
| `max_completion_tokens` | 支持，且优先于 `max_tokens`（含思维链预算） |

### 3.3 引擎侧注入的环境变量

`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENCODE_API_KEY` / `OPENCODE_PROVIDER_BASE_URL` / `OPENCODE_MODEL` / `OPENCODE_PROVIDER_NAME`，
外加 `ENGINE_MAAS_TOKEN_URL` / `ENGINE_MAAS_TOKEN_AUTH`。
Codex 引擎还额外收到 `CODEX_CONFIG`：`model_providers[id] = { base_url, wire_api: "responses", auth: { command } }`。

宿主还开了个**本地取 token 端点**给引擎用（`agent-sdk/helpers/fetch-maas-token.cjs`）：
`GET http://127.0.0.1:<随机端口>/maas-token?session_id=&app_mode=`，请求头 `x-api-key: <64 位 hex>`，返回裸 key。

---

## 4. 本地模型代理：路由与 turn 作用域

宿主在进程内起一个 `InProcessLocalModelProxy`（`app.asar`），随机端口监听 `127.0.0.1`：

- **只接受 POST**，其它方法一律 `404 ROUTE_NOT_FOUND`。
- 用 `Authorization` 头里的**本地 token**（`LOCAL_TOKEN_PATTERN` 匹配 + `tokenHash` 常量时间比较）选中 route。
- route 里带着该会话的上游信息与凭证，代理转发到 MaaS 网关。
- **turn 作用域**：宿主必须为该会话登记了活跃 turn，否则返回
  `409 {"error":{"code":"TURN_CONTEXT_MISSING","message":"Model request has no active turn context"}}`。

判据在源码里（`app.asar`）：

```js
const turn = requestTurn ?? (invocation ? {state:"active", ...} : turnRegistry.getSnapshot(runtimeScopeId));
if (turn.state !== "active" || !turn.turnId) throw new ModelProxyRequestError(409, "TURN_CONTEXT_MISSING", ...);
```

即**只要桌面端这一轮对话没在跑，代理就不放行**。这是「独立脚本调千问办公模型」最常见的失败原因（表现为 503）。

### 4.1 旁路：auxiliary lease

代码里还有一条豁免路径：请求头 `x-qwenwork-parent-context-execution-id`（常量 `AUXILIARY_EXECUTION_HEADER`）。
命中后代理去 `pr.auxiliary.get(executionId)` 取一份**租约**（含 turn 快照、`remaining` 次数、`expiresAt`，租约时长 `AUXILIARY_EXECUTION_LEASE_MS = 45e3`），
租约存在就放行，且路径必须是 `/v1/responses`、`/v1/chat/completions`、`/v1/messages` 之一。

这条路径服务于宿主自己 fork 出去的子执行（ACP `parentContext` / `runParentContext`），
租约由宿主发放、外部拿不到，所以**这条路对第三方脚本不可用**。

路由与 turn 的来源：

```
~/.qwenworkcn/.harness/flash-cli/config/<session>/launch-config/<uuid>.json
  provider.<name>.options.baseURL   -> http://127.0.0.1:<port>/v1
  provider.<name>.options.apiKey    -> 本地路由 token
  provider.<name>.models            -> 该会话目录里的模型
  mcp."qw-builtin".url              -> 宿主本地 JSON-RPC/MCP 端点（工具面）
```

**实测行为**（对活跃会话发请求）：

| 请求 | 结果 |
|---|---|
| `POST /v1/chat/completions` `model=minimax-m3.1-flash` | 200，OpenAI 形状响应 |
| 同上 `stream:true` | 200，`text/event-stream`，chunk 为标准 `chat.completion.chunk` |
| `model=qwen3.8-max-preview / glm-5.3 / kimi-k3.1-pro / deepseek-v4-pro / step-5-preview / qwen4-max / lite` | 200（**跨 provider 都能路由**） |
| `model=qwen3-max / qwen-max` | 400 `invalid_request`（目录里没有这些 id） |
| 非活跃会话 | 409 `TURN_CONTEXT_MISSING` |

---

## 5. 媒体生成是另一条链路

图片/视频/音乐**不走** MaaS 对话链路，而是走内置 router 工具：

```
qwenwork-router list                      # 列出可用模型 + action
qwenwork-router params <model_id>/<action> # 查参数
qwenwork-router run <model_id>/<action> --flag value
```

本机目录里同时有 `qwenwork/open-image-2`、`qwenwork/seedance-2.0`、`alibaba/qwen-image-3.0`、`alibaba/wan3.0-video`、`minimax/minimax-music-3.0` 等，
按 `model_id + action`（`generation` / `edit` / `text-to-video` / `image-to-video` / `reference-to-video`）路由，底层是 OpenAPI v1 媒体网关。
目录里**没有对话类 endpoint**，所以对话不能走 router。

---

## 6. 自定义模型（BYOK）

QwenWork 允许用户登记自有的 OpenAI 兼容服务，落库在 `agents.db` 的 `byok_custom_models` 表
（`display_name / provider / type / url / style / model / format / is_vl / is_reasoning / encrypted_parameters`）。
本机账号状态 `allow_byok: 0`（企业基础版），所以该表为空——即当前套餐下**不能**用自带 key 接第三方模型。

---

## 7. 这对「做 OpenAI 封装」意味着什么

| 目标 | 可行性 | 做法 |
|---|---|---|
| 复用千问办公的模型能力 | ✅ | **直连 MaaS**：解开宿主的 accessKey，打 `https://api9.qwenwork.cn/v1`（配套 `qwenwork-openai-gateway` 的默认模式） |
| 不依赖桌面端活跃 turn | ✅ | 直连不经过进程内代理，turn 结束照样能调；桌面端只需定期续期凭证 |
| 走宿主进程内代理 | ⚠️ 受限 | turn 作用域，空闲时 409；适合调试宿主链路，不适合做长期服务 |
| 把媒体生成也封成 OpenAI 形状 | ✅ | 额外加 `/v1/images/generations` 等端点，内部转调 router |
| 把办公文档工具（Word/Excel/PPT）也封进去 | ✅ | 走宿主本地 MCP 端点 `mcp."qw-builtin".url`（JSON-RPC，`x-api-key` 鉴权），本机实测 `initialize` / `tools/list` 均正常，工具数 39 |

**结论**：做 OpenAI 封装不该复用那个 turn 作用域的本地代理，而应**直连 MaaS 网关**。
网关只在内存里解开宿主自己的凭证、每次挑一把没过期的 key，不落盘、不打印、不搬运密钥；
桌面端不在线时自动降级，并在 `/health` 里报告凭证剩余有效期。
