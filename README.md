# qwenwork-openai-gateway

把**千问办公（QwenWork CN）**的模型调用能力包装成一个标准 **OpenAI 兼容 API**：
任何支持 `base_url` 的客户端（OpenAI SDK、LangChain、LiteLLM、Cline、Continue、自研服务……）改一行配置就能用上千问办公的模型。

机制细节见 [MECHANISM.md](./MECHANISM.md)。

---

## 它是怎么工作的

```
你的客户端 (OpenAI SDK / curl)
      │  POST /v1/chat/completions
      ▼
qwenwork-openai-gateway  (127.0.0.1:8787)
      │  解开宿主自己的 MaaS 凭证（登录钥匙串 + safeStorage）
      │  → accessKey(sk-mm-v1.*) + baseUrl(https://api9.qwenwork.cn/v1)
      ▼
千问办公 MaaS 网关
      ▼
Qwen / GLM / Kimi / DeepSeek / MiniMax / Step ...
```

**要点**：网关不保存、不打印任何密钥。每次需要上游凭证时，它在内存里解开宿主自己的凭证文件，
取一把还没过期的 `accessKey` 直接打 MaaS 网关。因此：

- **不受「宿主活跃 turn」限制** —— 不经过桌面端进程内那个 turn 作用域的模型代理，桌面端空闲也能调；
- 额度、并发、模型可用性完全跟随你的千问办公账号；
- `accessKey` 有 TTL（通常 2 小时），由桌面端续期后落盘，网关每 30 秒重读一次；
- 万一凭证不可用（钥匙串被锁 / 文件缺失），网关**自动降级**为走宿主进程内代理；
- 也可以用 `QWENWORK_PROXY_BASE_URL` / `QWENWORK_PROXY_TOKEN` 指向任意 OpenAI 兼容上游（自有 MaaS key、自建代理等），优先级最高。

---

## 安装

```bash
git clone https://github.com/zhangzhangco/qwenwork-openai-gateway.git
cd qwenwork-openai-gateway
node -v            # 需要 >= 18
npm run doctor     # 自检：凭证解得开吗？通道通吗？
npm start          # 启动，默认 127.0.0.1:8787
```

零依赖，不需要 `npm install`。

> **平台**：直连模式依赖 macOS 的 `security`（登录钥匙串）命令，目前**仅 macOS 可用**。
> Linux / Windows 下可以用 `QWENWORK_PROXY_BASE_URL` + `QWENWORK_PROXY_TOKEN` 指向任意 OpenAI 兼容上游，
> 或用 `QWENWORK_CREDENTIAL_FILE` 指向你自己的凭证文件（格式见 `lib/credential.mjs`）。

## 快速开始

```bash
cd qwenwork-openai-gateway
node scripts/doctor.mjs          # 自检：凭证解得开吗？通道通吗？
node server.mjs                   # 启动，默认 127.0.0.1:8787
```

```bash
curl http://127.0.0.1:8787/v1/models
curl http://127.0.0.1:8787/health
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"你好"}]}'
```

### OpenAI SDK

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "local-dev",            // 网关未开启鉴权时任意填
});

const r = await client.chat.completions.create({
  model: "qwen4-max",
  messages: [{ role: "user", content: "写一句自我介绍" }],
});
console.log(r.choices[0].message.content);

const stream = await client.chat.completions.create({
  model: "minimax-m3.1-flash",
  messages: [{ role: "user", content: "从1数到5" }],
  stream: true,
});
for await (const part of stream) process.stdout.write(part.choices[0]?.delta?.content ?? "");
```

### Python（openai SDK）

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local-dev")
resp = client.chat.completions.create(
    model="kimi-k3.1-pro",
    messages=[{"role": "user", "content": "你好"}],
    max_completion_tokens=800,   # 推理模型的 max_tokens 含思维链 token，别设太小
)
print(resp.choices[0].message.content)
```

---

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/models` | OpenAI 模型列表（来自 `config/models.json`） |
| `POST` | `/v1/chat/completions` | 对话补全，支持 `stream` / `tools` / `temperature` / `max_tokens` / `max_completion_tokens` 等，透传给上游 |
| `POST` | `/v1/messages` | Anthropic Messages 形状透传（给 Anthropic SDK 用） |
| `GET` | `/health` | 网关状态 + 当前通道模式 + 凭证剩余有效期 |

请求体基本原样转发，因此上游支持的 OpenAI 参数都能用。
推理类模型的思维链会出现在 `message.reasoning_content` / `delta.reasoning_content`（千问办公侧的扩展字段，非 OpenAI 标准）。

> **推理模型的坑**：上游把 `max_tokens` / `max_completion_tokens` 都当作**含思维链**的总预算。
> 思维链吃满预算后 `content` 会是空字符串、`finish_reason` 为 `length`——这不是网关丢字段。
> 思维链长度本身随请求波动，同样的预算有时出内容、有时不出。
> 最稳的做法：给推理模型**不传上限**，或留足预算（≥ 2000）；同时读 `reasoning_content` 看思考过程。

---

## 安全说明

- 网关**只读**本机千问办公自己的凭证文件（`~/.qwenworkcn/engine-maas-key.dat`）和登录钥匙串里的 safeStorage 密码，
  用来解出你自己账号的 `accessKey`。
- 解出的密钥**只存在于进程内存**，不写盘、不打印、不上传到任何第三方服务；
  它只会随请求发往千问办公官方的 MaaS 网关（`https://api9.qwenwork.cn/v1`）。
- 网关本身不新增任何对外通道；默认只监听 `127.0.0.1`。
  如果要对外暴露，务必设置 `GATEWAY_API_KEY`，并自行承担网络暴露风险。
- 网关会使用你账号的额度，所有请求都算在你的千问办公账号上。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（设 `0.0.0.0` 可对外暴露，务必同时开 `GATEWAY_API_KEY`） |
| `GATEWAY_API_KEY` | 空 | 客户端鉴权 key；非空时要求 `Authorization: Bearer <key>` 或 `x-api-key` |
| `QWENWORK_PROXY_BASE_URL` | 空 | 指定上游 base（须为 OpenAI 兼容），设置后**跳过**自动发现与直连 |
| `QWENWORK_PROXY_TOKEN` | 空 | 上游 `Authorization: Bearer` 的值 |
| `QWENWORK_KEYCHAIN_SERVICE` | `QwenWorkCN Safe Storage` | 存 safeStorage 密码的钥匙串服务名 |
| `QWENWORK_CREDENTIAL_FILE` | `~/.qwenworkcn/engine-maas-key.dat` | 宿主凭证文件路径 |
| `QWENWORK_MODELS_FILE` | `config/models.json` | 自定义模型注册表 |
| `ROUTE_TTL_MS` | `8000` | 通道缓存时长 |
| `CREDENTIAL_TTL_MS` | `30000` | 凭证重读间隔（桌面端会持续续期） |
| `CORS_ORIGIN` | `*` | CORS 允许来源 |

---

## 模型

`config/models.json` 里注册，字段：`id` / `display_name` / `verified` / `reasoning` / `vision` / `context`。

**15 个 id 全部已直连 MaaS 网关实测通过**（2026-11-26，非流式 + 流式 + function calling）：
`qwen4-max`、`qwen3.8-max-preview`、`qwen3.8-flash`、`glm-5.4`、`glm-5.3`、`glm-5.3-flash`、
`kimi-k3.1-pro`、`deepseek-v4-pro`、`deepseek-flash`、`minimax-m3.1-flash`、`step-5-preview`、
`ling-3.1-flash`、`flash`、`pro`、`lite`。

不在目录里的 model id 会被上游拒绝（400 `invalid_request`）——**模型可用性由千问办公的目录决定，网关不新增模型**。
新增模型只需往 `config/models.json` 追加一条。

---

## 已知限制

1. **凭证依赖桌面端续期**：`accessKey` 由千问办公桌面端签发并续期（TTL 约 2 小时）。
   桌面端长期不运行 → 凭证过期 → 网关降级为宿主代理模式 → 空闲时回 `503`。
   `/health` 里的 `credential.remaining_min` 会显示剩余有效期。
2. **降级模式受 turn 限制**：只有走宿主进程内代理时，才需要桌面端有活跃 turn（否则 409 → 网关转 503）。
   正常情况下走的是直连模式，没有这个限制。
3. **并发**：所有请求共用同一把 `accessKey`，受千问办公自身的并发与额度约束。
4. **仅对话**：本封装只覆盖文本/多模态对话链路。图片/视频/音乐生成走千问办公的**另一条** router 链路
   （`model_id + action`，OpenAPI v1 媒体网关），需要另加 `/v1/images/generations` 之类的端点转调。
5. **办公文档工具**（Word/Excel/PPT）走宿主本地 MCP 端点，不在本封装内；
   如需「OpenAI function calling + 办公工具」，可把该 MCP 端点的工具 schema 转成 `tools` 传进来。

---

## 目录结构

```
qwenwork-openai-gateway/
├── server.mjs                 # OpenAI 兼容 HTTP 服务
├── lib/credential.mjs         # 解开宿主的 MaaS 凭证（钥匙串 + safeStorage）
├── lib/host-bridge.mjs        # 通道选择（直连 / 宿主代理 / env）+ 请求转发
├── lib/registry.mjs           # 模型注册表
├── config/models.json         # 模型清单
├── scripts/doctor.mjs         # 环境自检
├── MECHANISM.md               # 千问办公模型调用机制（逆向结论 + 证据）
└── README.md
```
