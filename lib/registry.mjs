/**
 * registry —— 模型注册表：把 config/models.json 暴露成 OpenAI /v1/models 的形状。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const registryPath = process.env.QWENWORK_MODELS_FILE || path.join(here, "..", "config", "models.json");

let cache = null;

export function loadRegistry() {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const models = (raw.models || []).map((m) => ({
    id: m.id,
    object: "model",
    created: 1700000000,
    owned_by: "qwenwork",
    display_name: m.display_name || m.id,
    verified: !!m.verified,
    reasoning: !!m.reasoning,
    vision: !!m.vision,
    context_window: m.context || 0,
    max_output_tokens: m.max_output || 0,
  }));
  cache = models;
  return cache;
}

export function toOpenAIList(models = loadRegistry()) {
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created,
      owned_by: m.owned_by,
      // 扩展元数据：标准 OpenAI 客户端会忽略未知字段，向后兼容。
      display_name: m.display_name,
      context_window: m.context_window,
      max_output_tokens: m.max_output_tokens,
      reasoning: m.reasoning,
      vision: m.vision,
    })),
  };
}

export function findModel(id) {
  return loadRegistry().find((m) => m.id === id) || null;
}
