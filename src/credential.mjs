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
