// src/credential.mjs —— 与厂商无关的凭据读取、分类与身份标识
//
// 形状识别由各插件注入；这里不保存凭据、不访问网络，也不读写缓存文件。

import { createHash } from "node:crypto"

/**
 * 读取原始凭据，优先级为 access → key → token，并去掉首尾空白。
 * refresh 只用于 uidOf 的身份指纹，不在这里冒充可调用上游的访问凭据。
 *
 * @param {{access?: *, key?: *, token?: *}} [auth] magpie 的 auth 对象
 * @returns {string} 没有凭据时返回空串
 */
export function rawCredentialOf(auth) {
  if (!auth) return ""
  for (const candidate of [auth.access, auth.key, auth.token]) {
    const value = String(candidate || "").trim()
    if (value) return value
  }
  return ""
}

/**
 * 计算凭据的 12 位 SHA-256 指纹，仅用于区分账号，不参与鉴权。
 *
 * @param {*} raw 原始凭据
 * @returns {string} 小写十六进制指纹，不包含原始 token
 */
export function fingerprint(raw) {
  return createHash("sha256").update(String(raw || "")).digest("hex").slice(0, 12)
}

/**
 * 读取 auth.metadata；缺失、null 或非对象时返回新的空对象。
 *
 * @param {{metadata?: *}} [auth] magpie 的 auth 对象
 * @returns {Record<string, *>} 原 metadata 对象或空对象
 */
export function metadataOf(auth) {
  return auth?.metadata && typeof auth.metadata === "object" ? auth.metadata : {}
}

/**
 * 解析凭据种类，严格按 cached.kind → metadata.kind → shape detector 的顺序。
 *
 * shapeDetector 接收原始凭据，可返回种类字符串，或返回带 kind 字段的对象；
 * 未提供探测器、探测器无结果时回退为 "unknown"。前两级已有 kind 时不调用探测器。
 *
 * @param {*} auth magpie 的 auth 对象
 * @param {{kind?: *}} [cached] 调用方已识别并缓存的记录
 * @param {(raw: string) => (string | {kind?: *} | null | undefined)} [shapeDetector] 厂商形状探测器
 * @returns {string}
 */
export function credentialKindOf(auth, cached, shapeDetector) {
  if (cached?.kind) return String(cached.kind)
  const metadataKind = metadataOf(auth).kind
  if (metadataKind) return String(metadataKind)
  if (typeof shapeDetector !== "function") return "unknown"
  const detected = shapeDetector(rawCredentialOf(auth))
  const kind = detected && typeof detected === "object" ? detected.kind : detected
  return kind ? String(kind) : "unknown"
}

/**
 * 解析账号身份，优先级为 record.userId → metadata.userId → auth.uid → 凭据指纹。
 * 指纹是最后回退，绝不直接返回原始 token。
 *
 * @param {*} auth magpie 的 auth 对象
 * @param {{userId?: *}} [record] 厂商用户记录
 * @returns {string} 没有任何身份或凭据时返回空串
 */
export function uidOf(auth, record) {
  // refresh_token 通常比 access_token 稳定；有它时优先作为账号身份，仍只存指纹。
  const refresh = String(auth?.refresh || "").trim()
  const raw = refresh || rawCredentialOf(auth)
  return String(record?.userId || metadataOf(auth).userId || auth?.uid || (raw ? fingerprint(raw) : ""))
}

/**
 * 生成「稳定身份」的 metadata。
 *
 * 为什么必须有它：magpie 对 **`type: "api"`** 的登录态只持久化
 * `{ type, key, metadata }`（2026-11-09 实测）—— 顶层的 `uid` / `accountScope` /
 * `expires` 全部丢掉。而 `uidOf()` 本来就把 `metadata.userId` 排在 `auth.uid` 之前，
 * 所以「同账号换 token 不换设备」唯一可靠的落点就是这里。
 *
 * 合并而不是替换：`refresh` 的返回值会被宿主**合并**进旧记录，只给 `{ email }`
 * 会把 `metadata.userId` / `metadata.accountScope` 冲掉（那就又退回凭据指纹了）。
 *
 * @param {{metadata?: *}} [auth] 旧登录态（续期时传入；登录时传 undefined）
 * @param {{accountId?: string, uid?: string, accountScope?: string}} [patch]
 * @returns {Record<string, *>} 合并后的 metadata
 */
export function metadataWithIdentity(auth, { accountId = "", uid = "", accountScope = "" } = {}) {
  const next = { ...metadataOf(auth) }
  const name = String(accountId ?? "").trim()
  const id = String(uid ?? "").trim()
  const scope = String(accountScope ?? "").trim()
  if (name) next.email = name
  if (id) next.userId = id
  if (scope) next.accountScope = scope
  return next
}

/**
 * 稳定作用域：`auth.accountScope` → `metadata.accountScope` → 安装记录里的值。
 *
 * 三种登录态都要认：oauth 型留顶层，api 型只剩 metadata，旧记录只在安装记录里。
 * **不跨账号回退**：拿不到就返回空串，调用方去问 profile 或按「没有」处理。
 *
 * @param {*} auth magpie 的 auth 对象
 * @param {{accountScope?: *}} [record] 安装记录
 * @returns {string} 空串 = 未知
 */
export function accountScopeOf(auth, record) {
  for (const candidate of [auth?.accountScope, metadataOf(auth).accountScope, record?.accountScope]) {
    const value = String(candidate ?? "").trim()
    if (value) return value
  }
  return ""
}
