/**
 * credential —— 读取千问办公桌面端自己的 MaaS accessKey。
 *
 * 桌面端把自己的上游凭证用 Electron safeStorage（Chromium OSCrypt）加密后落在
 *   ~/.qwenworkcn/engine-maas-key.dat
 * 文件布局： "v10" | iv(16) | AES-128-CBC(密文)
 * 密钥派生： PBKDF2-HMAC-SHA1(登录钥匙串密码, "saltysalt", 1003 次, 16 字节)
 * 钥匙串项： "QwenWorkCN Safe Storage"
 *
 * 解出的明文是一段 JSON：
 *   {"version":2,"identityFingerprint":"…","credentials":{"<sessionId>":{
 *      accessKey:"sk-mm-v1.…", baseUrl:"https://api9.qwenwork.cn/v1",
 *      expiresAtMs:…, ttlMs:7200000, maasSessionId:"…" }}}
 *
 * 拿到了 accessKey 就可以直接打 MaaS 网关，不必再经过桌面端进程内的模型代理，
 * 也就摆脱了「代理只在宿主有活跃 turn 时放行」的限制。
 *
 * 注意：key 只在内存里用，不落盘、不打印。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const CRED_FILE =
  process.env.QWENWORK_CREDENTIAL_FILE || path.join(os.homedir(), ".qwenworkcn/engine-maas-key.dat");
const KEYCHAIN_SERVICE = process.env.QWENWORK_KEYCHAIN_SERVICE || "QwenWorkCN Safe Storage";

let cachedPassword = null;

/** 读登录钥匙串里的 safeStorage 密码（进程内缓存，避免反复触发授权弹窗）。 */
function keychainPassword() {
  if (cachedPassword) return cachedPassword;
  const out = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  cachedPassword = out.trim();
  return cachedPassword;
}

/**
 * 解密凭证文件。
 * 宿主把 JSON 的前 10 个字符（`{"version`）留在明文区，所以解密结果需要补回前缀；
 * 这里两种形态都兼容。
 */
export function decryptCredentialFile(file = CRED_FILE) {
  const raw = fs.readFileSync(file);
  if (raw.subarray(0, 3).toString("utf8") !== "v10") throw new Error("凭证文件格式不是 v10");
  const body = raw.subarray(3);
  const iv = body.subarray(0, 16);
  const ct = body.subarray(16);
  const key = crypto.pbkdf2Sync(Buffer.from(keychainPassword(), "utf8"), "saltysalt", 1003, 16, "sha1");
  const d = crypto.createDecipheriv("aes-128-cbc", key, iv);
  const plain = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  try {
    return JSON.parse(plain);
  } catch {
    return JSON.parse('{"version"' + plain);
  }
}

/**
 * 凭证仓库：定期重新读盘解密（桌面端会自己续期），挑剩余有效期最长的那把 key。
 */
export class CredentialStore {
  constructor({ ttlMs = 30000, file = CRED_FILE } = {}) {
    this.ttlMs = ttlMs;
    this.file = file;
    this.snapshot = null;
    this.snapshotAt = 0;
  }

  /** @returns {{ok:boolean, reason?:string, credentials:Array, identityFingerprint?:string, checkedAt:number}} */
  get({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.snapshot && now - this.snapshotAt < this.ttlMs) return this.snapshot;
    let parsed;
    try {
      parsed = decryptCredentialFile(this.file);
    } catch (e) {
      this.snapshot = {
        ok: false,
        reason: e.code === "ENOENT" ? "credential_file_missing" : `credential_unreadable: ${e.message}`,
        credentials: [],
        checkedAt: now,
      };
      this.snapshotAt = now;
      return this.snapshot;
    }
    const nowMs = Date.now();
    const credentials = Object.entries(parsed.credentials || {})
      .map(([sessionId, v]) => ({
        sessionId,
        accessKey: v.accessKey,
        baseUrl: (v.baseUrl || "").replace(/\/+$/, ""),
        expiresAtMs: v.expiresAtMs || 0,
        ttlMs: v.ttlMs || 0,
        maasSessionId: v.maasSessionId || null,
      }))
      .filter((c) => c.accessKey && c.baseUrl)
      .sort((a, b) => b.expiresAtMs - a.expiresAtMs); // 剩余有效期最长的排前面
    this.snapshot = {
      ok: credentials.length > 0,
      reason: credentials.length ? null : "no_credential_entries",
      credentials,
      identityFingerprint: parsed.identityFingerprint || null,
      checkedAt: nowMs,
    };
    this.snapshotAt = nowMs;
    return this.snapshot;
  }

  /** 当前可用的凭证（未过期的），按剩余有效期排序。 */
  live({ force = false } = {}) {
    const snap = this.get({ force });
    const now = Date.now();
    return snap.credentials.filter((c) => !c.expiresAtMs || c.expiresAtMs > now);
  }
}
