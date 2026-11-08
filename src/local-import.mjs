// src/local-import.mjs —— 「从本机导入现有 Phanthy 登录」的检测与严格导入
//
// 真实落点（静态 + 本机核对）：`%USERPROFILE%\.phanthy-code\.credentials.json`，
// 顶层是 `claudeAiOauth`，字段为 `accessToken / refreshToken / expiresAt / scopes`。
// 桌面端那套 `desktop\settings.json` 里的 `ANTHROPIC_AUTH_TOKEN` 是**内部桥 Bearer**，
// 不是云端登录，本模块不读它、也不把它当候选。
//
// 规则写死在这里，不靠自觉：
//   ✅ 只接受：未过期的云端 access token
//   ❌ 拒绝：已过期 / 缺 expiresAt —— 拿到的是一张死票，宁可让用户走 OAuth
//   ❌ 拒绝：refresh_token —— 一次性轮换，插件一刷桌面端就 invalid_grant 掉线
//   ❌ 拒绝：desktop_inference_token、设备 ed25519 私钥 —— 等于复制设备会话
//
// 因此「导入」= 借一张**还没过期**的短效通行证；设备身份仍由插件自己注册。
// 输出只有存在性、字段名、类型、剩余秒数 —— 永远不含值。

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** 官方 CLI 内核的凭据目录名 */
export const CREDENTIAL_DIR = ".phanthy-code"

/** 凭据文件名 */
export const CREDENTIAL_FILE = ".credentials.json"

/** 顶层节点名 */
export const OAUTH_NODE = "claudeAiOauth"

/** 凭据文件绝对路径（Windows/macOS/Linux 都用 homedir） */
export function credentialsFile(home = homedir()) {
  return join(home, CREDENTIAL_DIR, CREDENTIAL_FILE)
}

/** 候选文件（只有这一处有证据） */
export function candidateFiles(home = homedir()) {
  return [credentialsFile(home)]
}

/** 导入被拒绝时抛这个；`code` 在词表内，`reason` 是给人看的稳定标识 */
export class LocalImportError extends Error {
  constructor(message, { reason = "local_import_refused" } = {}) {
    super(message)
    this.name = "LocalImportError"
    this.code = "invalid_request"
    this.status = 400
    this.reason = reason
  }
}

/** 只描述形状：键名 + 类型，**不含值**。深度限制 2 层。 */
export function describe(value, depth = 0) {
  if (value === null) return "null"
  if (Array.isArray(value)) return depth > 1 ? "array" : value.map((item) => describe(item, depth + 1))
  if (typeof value === "object") {
    if (depth > 1) return "object"
    const out = {}
    for (const key of Object.keys(value)) out[key] = describe(value[key], depth + 1)
    return out
  }
  return typeof value
}

const ACCESS_KEYS = ["accessToken", "access_token", "access"]
const REFRESH_KEYS = ["refreshToken", "refresh_token", "refresh"]
const DEVICE_KEYS = ["privateKey", "private_key", "ed25519", "device_private_key", "desktop_inference_token"]
const BRIDGE_KEYS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "phanthyBaseUrl"]

function dig(object, keys) {
  for (const key of keys) {
    if (object && typeof object === "object" && key in object) return { key, value: object[key] }
  }
  return null
}

/** 取 `claudeAiOauth` 节点；没有就退回顶层（兼容别的落点写法） */
export function oauthNode(config) {
  if (!config || typeof config !== "object") return null
  const node = config[OAUTH_NODE]
  return node && typeof node === "object" ? node : config
}

/** 剩余秒数：负数是已过期多少秒 */
export function remainingSeconds(expiresAt, now = Date.now()) {
  const ms = Number(expiresAt)
  if (!Number.isFinite(ms) || ms <= 0) return null
  return Math.round((ms - now()) / 1000)
}

/**
 * 分类：这份配置里有什么、能不能导入、过期了没有。
 *
 * @param {unknown} config 解析后的 `.credentials.json`
 * @param {{now?:()=>number}} [options]
 */
export function classifyCredential(config, { now = Date.now } = {}) {
  if (!config || typeof config !== "object") {
    return { kind: "empty", importable: false, reason: "配置不是对象", fields: [], expired: null, remainingSeconds: null }
  }
  const node = oauthNode(config)
  const fields = Object.keys(node ?? {})

  if (dig(node, DEVICE_KEYS)) {
    return { kind: "device_secret", importable: false, reason: "含设备私钥或推理令牌，规则禁止复制设备会话", fields, expired: null, remainingSeconds: null }
  }
  if (dig(node, BRIDGE_KEYS)) {
    return {
      kind: "bridge_bearer",
      importable: false,
      reason: "这是桌面端内部桥的 Bearer/地址，只在桌面进程内有效，不是云端 OAuth 凭据",
      fields,
      expired: null,
      remainingSeconds: null,
    }
  }

  const access = dig(node, ACCESS_KEYS)
  const refresh = dig(node, REFRESH_KEYS)
  const expiresAt = node?.expiresAt ?? node?.expires_at ?? node?.expires
  const left = remainingSeconds(expiresAt, now)

  if (!access || typeof access.value !== "string" || !access.value.trim()) {
    if (refresh) {
      return {
        kind: "refresh_only",
        importable: false,
        reason: "只有 refresh_token：导入后插件一刷新，桌面端就会因 invalid_grant 掉线",
        fields,
        expired: null,
        remainingSeconds: null,
      }
    }
    return { kind: "unknown", importable: false, reason: "没有可识别的云端 access token", fields, expired: null, remainingSeconds: null }
  }

  if (left === null) {
    return {
      kind: "cloud_access_no_expiry",
      importable: false,
      reason: "缺少 expiresAt：无法确认 token 是否还有效，不猜",
      fields,
      expired: null,
      remainingSeconds: null,
    }
  }
  if (left <= 0) {
    return {
      kind: "cloud_access_expired",
      importable: false,
      reason: `access token 已过期 ${Math.abs(left)} 秒，请用浏览器 OAuth（不会使用 refresh_token 顶掉本机登录）`,
      fields,
      expired: true,
      remainingSeconds: left,
    }
  }
  return {
    kind: "cloud_access",
    importable: true,
    reason: `云端 access token，剩余 ${left} 秒`,
    fields,
    expired: false,
    remainingSeconds: left,
  }
}

/**
 * 只读检测：文件在不在、形状、分类、剩下多久。**不返回值**。
 */
export function detectLocalLogin({
  home = homedir(),
  now = Date.now,
  readFile = (path) => readFileSync(path, "utf8"),
  exists = (path) => existsSync(path),
  files = candidateFiles(home),
} = {}) {
  const candidates = []
  for (const file of files) {
    const present = Boolean(exists(file))
    const entry = { file, exists: present }
    if (present) {
      try {
        const parsed = JSON.parse(readFile(file))
        entry.shape = describe(parsed)
        entry.classification = classifyCredential(parsed, { now })
      } catch (error) {
        entry.parseError = String(error?.message ?? error)
      }
    }
    candidates.push(entry)
  }

  const importable = candidates.find((entry) => entry.classification?.importable)
  return {
    file: files[0] ?? "",
    found: candidates.some((entry) => entry.exists),
    importable: Boolean(importable),
    candidate: importable ?? null,
    candidates,
  }
}

/**
 * 真正取 access token。只返回 `{access, expires, remainingSeconds, sourceFile, importedAt}`。
 * 过期 / 缺失 / 只有 refresh 一律抛错 —— 不猜、不回退、不读第二个文件。
 */
export function readImportedAccess({
  home = homedir(),
  now = Date.now,
  readFile = (path) => readFileSync(path, "utf8"),
  exists = (path) => existsSync(path),
} = {}) {
  const detection = detectLocalLogin({ home, now, readFile, exists })
  const entry = detection.candidate
  if (!entry) {
    // 过期是**可识别**的状态：单独报出来，别让它和「文件不存在」混成一句话
    const expired = detection.candidates.find((item) => item.classification?.kind === "cloud_access_expired")
    if (expired) {
      throw new LocalImportError(
        `本机 access token 已过期 ${Math.abs(expired.classification.remainingSeconds)} 秒，请用浏览器 OAuth` +
          "（不会用 refresh_token 顶掉本机登录）",
        { reason: "local_token_expired" },
      )
    }
    const reasons = detection.candidates
      .map((item) => (item.exists ? item.classification?.reason ?? item.parseError : "文件不存在"))
      .filter(Boolean)
    throw new LocalImportError(
      `没有可导入的云端登录（${reasons.join("；") || "未找到凭据文件"}）。` +
        "插件只导入未过期的云端 access token，不会使用 refresh_token、推理令牌或设备私钥。",
      { reason: "local_login_not_importable" },
    )
  }

  const parsed = JSON.parse(readFile(entry.file))
  const node = oauthNode(parsed)
  const hit = dig(node, ACCESS_KEYS)
  const access = typeof hit?.value === "string" ? hit.value.trim() : ""
  if (!access) throw new LocalImportError("云端 access token 为空，无法导入", { reason: "local_access_empty" })

  const expires = Number(node?.expiresAt ?? node?.expires_at ?? node?.expires) || 0
  const left = remainingSeconds(expires, now)
  if (left === null) throw new LocalImportError("凭据缺少 expiresAt，无法确认有效期", { reason: "local_expiry_missing" })
  if (left <= 0) {
    throw new LocalImportError(`本机 access token 已过期 ${Math.abs(left)} 秒，请用浏览器 OAuth`, {
      reason: "local_token_expired",
    })
  }

  return { access, expires, remainingSeconds: left, sourceFile: entry.file, importedAt: now() }
}

/** 给卡片/日志用的一句话总结：只有存在性、分类、剩余秒数、字段名 */
export function summarizeDetection(detection) {
  const lines = detection.candidates.map((entry) => {
    if (!entry.exists) return `${entry.file}: 不存在`
    if (entry.parseError) return `${entry.file}: 存在但无法解析（${entry.parseError}）`
    const classification = entry.classification
    const keys = classification?.fields ?? []
    const left = classification?.remainingSeconds
    const state = classification?.importable
      ? `可导入（剩余 ${left} 秒）`
      : `不可导入（${classification?.reason ?? "未知"}）`
    return `${entry.file}: 存在 · 字段 ${keys.join(",") || "无"} · 分类 ${classification?.kind ?? "unknown"} · ${state}`
  })
  return { found: detection.found, importable: detection.importable, lines }
}
