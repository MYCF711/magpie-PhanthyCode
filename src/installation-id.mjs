// src/installation-id.mjs —— installationId 的派生（官方算法，2026-11-09 真机实测确认）
//
// 唯一算法（抓包 → 逐字符复现 → 200 通过）：
//
//   installationId = "di_" + base64url( sha256( SPKI_DER[12:] ) )
//
// 即：取 ed25519 公钥的 SPKI/DER（44 字节 = 12 字节固定头 + 32 字节裸公钥），
// **丢掉前 12 字节头**（`302a300506032b6570032100`），对剩下的 32 字节裸公钥做
// sha256，base64url（无填充）编码，最后加 `di_` 前缀 —— 整串 46 字符。
//
// 三条被实测否证过的写法（每一条都回 409 `desktop_installation_conflict`，
// 错误串是 "Desktop installation identifier does not match its public key."）：
//   ① 哈希 `accountScope` —— 早期版本这么写，与公钥无关，必然对不上。`installationIdFromScope`
//      只为兼容旧脚本保留，已标 deprecated；
//   ② 哈希整段 SPKI 原文（44 字节）—— 官方哈希的是**裸公钥**；
//   ③ 不加前缀 / 用 `di:` —— 前缀就是 `di_`。
//
// 派生是确定的：同一把公钥必然同一个 id。所以「A/B 双探针」会撞幂等键
// （`register:<installationId>`），不要拆两次。
//
// 还活着的用途：`candidatesFor` / `matchRule` 是**离线反推工具**（`scripts/derive-installation-id.mjs`），
// 拿着真实观测值反查是哪条规则 —— 那是验证，不是猜。规则名即证据标签。

import { createHash } from "node:crypto"

/** RFC 4122 的三个常用命名空间 */
export const NAMESPACES = {
  dns: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  url: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  oid: "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
}

/**
 * 官方 installationId 的前缀（不是空串、不是 `di:`）。
 * 2026-11-09 抓包值：`di_CJN39yf0ubUxUOS5lPV9Cr0REAkE2D2F7H0Y0x7lnUk`。
 */
export const INSTALLATION_ID_PREFIX = "di_"

/** ed25519 公钥 SPKI/DER 的固定 12 字节头（`30 2a 30 05 06 03 2b 65 70 03 21 00`） */
export const ED25519_SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex")

/** 裸公钥字节数（ed25519 只有 32 字节） */
const ED25519_RAW_KEY_BYTES = 32

/** 规则不确认时抛这个；`code` 在错误码词表内，`reason` 给人和日志看 */
export class InstallationIdRuleUnknown extends Error {
  constructor(rule) {
    super(
      rule
        ? `未知的 installationId 规则：${rule}`
        : "installationId 的派生规则尚未确认：官方算法是 di_ + base64url(sha256(裸公钥))，" +
          "先确认规则再注册，不要用注册次数试错",
    )
    this.name = "InstallationIdRuleUnknown"
    this.code = "internal_error"
    this.status = 502
    this.reason = "installation_id_rule_unknown"
  }
}

/** 给摘要 body 加官方前缀；已带前缀的原样返回（幂等） */
export function withPrefix(body) {
  const text = String(body ?? "")
  return text.startsWith(INSTALLATION_ID_PREFIX) ? text : `${INSTALLATION_ID_PREFIX}${text}`
}

/** 去掉官方前缀（回到 43 字符摘要 body）；不带前缀的原样返回 */
export function stripPrefix(value) {
  const text = String(value ?? "")
  return text.startsWith(INSTALLATION_ID_PREFIX) ? text.slice(INSTALLATION_ID_PREFIX.length) : text
}

/**
 * SPKI/base64url 公钥 → 裸 32 字节公钥。
 *
 * 只接受 ed25519 的 SPKI：长度必须是 44 字节、头必须是那 12 个固定字节。
 * 别的算法（RSA / P-256）在这里就炸掉，而不是拿一段偏移量哈希出一个没人认得的 id。
 */
export function rawEd25519PublicKey(publicKeyB64Url) {
  if (typeof publicKeyB64Url !== "string" || publicKeyB64Url.trim() === "") {
    throw new TypeError("rawEd25519PublicKey: publicKey 必须是非空字符串")
  }
  const der = Buffer.from(publicKeyB64Url, "base64url")
  if (der.length !== ED25519_SPKI_HEADER.length + ED25519_RAW_KEY_BYTES) {
    throw new TypeError(
      `rawEd25519PublicKey: ed25519 的 SPKI/DER 必须是 ${
        ED25519_SPKI_HEADER.length + ED25519_RAW_KEY_BYTES
      } 字节，实际 ${der.length} 字节`,
    )
  }
  if (!der.subarray(0, ED25519_SPKI_HEADER.length).equals(ED25519_SPKI_HEADER)) {
    throw new TypeError(
      `rawEd25519PublicKey: SPKI 头不是 ed25519（期望 ${ED25519_SPKI_HEADER.toString("hex")}，` +
        `实际 ${der.subarray(0, ED25519_SPKI_HEADER.length).toString("hex")}）`,
    )
  }
  return der.subarray(ED25519_SPKI_HEADER.length)
}

/** 官方规则名（`candidatesFor` / `matchRule` 的证据标签，不带 di_ 前缀） */
export const PUBLIC_KEY_RULE = "sha256(raw32(spki-der))-base64url"

/** RFC 4122 v5：namespace UUID + name（字符串或原始字节）→ UUID 字符串 */
export function uuidV5(namespace, name) {
  const ns = Buffer.from(String(namespace).replace(/-/g, ""), "hex")
  if (ns.length !== 16) throw new TypeError("uuidV5: namespace 必须是 UUID")
  const nameBytes = Buffer.isBuffer(name) ? name : Buffer.from(String(name), "utf8")
  const digest = createHash("sha1").update(ns).update(nameBytes).digest()
  const b = Buffer.from(digest.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  return formatUuid(b)
}

function formatUuid(bytes) {
  const hex = Buffer.from(bytes).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 把 32 字节摘要按 v4 形状排版（只改版本/变体位，不改内容） */
function uuidShaped(bytes) {
  const b = Buffer.from(bytes).subarray(0, 16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  return formatUuid(b)
}

function digest(text) {
  return createHash("sha256").update(text).digest()
}

/** 裸 32 字节公钥的 sha256（base64url）—— 官方摘要，不含 di_ 前缀 */
function rawPublicKeyDigest(publicKeyB64Url) {
  return createHash("sha256").update(rawEd25519PublicKey(publicKeyB64Url)).digest("base64url")
}

/**
 * 候选规则表：规则名 → 派生函数（产出**摘要 body**，不含 `di_` 前缀）。
 *
 * ⚠ 这些是**候选**，不是结论。命中判定必须由 `matchRule()` 用真实值比对。
 * 官方规则 `PUBLIC_KEY_RULE` 是其中第一条之外的那条，实测命中的就是它。
 */
export const RULES = Object.freeze({
  [PUBLIC_KEY_RULE]: (publicKeyB64Url) => rawPublicKeyDigest(publicKeyB64Url),
  "uuid-v4-shaped(sha256(spki-der))": (publicKeyB64Url) => uuidShaped(digest(Buffer.from(publicKeyB64Url, "base64url"))),
  "sha256(spki-der)-hex": (publicKeyB64Url) => digest(Buffer.from(publicKeyB64Url, "base64url")).toString("hex"),
  "sha256(spki-der)-base64url": (publicKeyB64Url) => digest(Buffer.from(publicKeyB64Url, "base64url")).toString("base64url"),
  "uuid-v4-shaped(sha256(spki-text))": (publicKeyB64Url) => uuidShaped(digest(Buffer.from(publicKeyB64Url, "utf8"))),
  "sha256(spki-text)-hex": (publicKeyB64Url) => digest(Buffer.from(publicKeyB64Url, "utf8")).toString("hex"),
  "sha256(spki-text)-base64url": (publicKeyB64Url) => digest(Buffer.from(publicKeyB64Url, "utf8")).toString("base64url"),
  "uuid-v5(dns, spki-base64url)": (publicKeyB64Url) => uuidV5(NAMESPACES.dns, publicKeyB64Url),
  "uuid-v5(url, spki-base64url)": (publicKeyB64Url) => uuidV5(NAMESPACES.url, publicKeyB64Url),
  "uuid-v5(dns, spki-der)": (publicKeyB64Url) => uuidV5(NAMESPACES.dns, Buffer.from(publicKeyB64Url, "base64url")),
  "spki-base64url(itself)": (publicKeyB64Url) => String(publicKeyB64Url),
})

/** 官方规则名（`installationIdFromPublicKey` 用的那条） */
export const OFFICIAL_RULE = PUBLIC_KEY_RULE

/**
 * 官方算法：`installationId = "di_" + base64url(sha256(SPKI_DER[12:]))`。
 *
 * 输入是 **identity** 公钥（SPKI/base64url）。与 accountScope 无关 ——
 * accountScope 只参与 device canonical 第 2 段，不参与 id 派生。
 *
 * @param {string} publicKeyB64Url ed25519 公钥（SPKI/DER/base64url）
 * @returns {string} `di_` + 43 字符 base64url（共 46 字符）
 */
export function installationIdFromPublicKey(publicKeyB64Url) {
  return withPrefix(rawPublicKeyDigest(publicKeyB64Url))
}

/**
 * @deprecated 错公式：哈希的是 `accountScope`，官方哈希的是**公钥**。
 *
 * 保留只为兼容旧脚本（`scripts/derive-installation-id.mjs --scope`、几个探针）：
 * 它的产出永远不是服务端认的值，只用来对照「旧实现差在哪」。
 * 生产路径一律用 {@link installationIdFromPublicKey}。
 */
export const SCOPE_RULE = "base64url(sha256(accountScope))"

/**
 * @deprecated 见 {@link SCOPE_RULE}：输入成分错了。生产路径用 {@link installationIdFromPublicKey}。
 */
export function installationIdFromScope(accountScope) {
  if (typeof accountScope !== "string" || accountScope.trim() === "") {
    throw new TypeError("installationIdFromScope: accountScope 必须是非空字符串")
  }
  return withPrefix(digest(accountScope).toString("base64url"))
}

/** 全部候选（官方格式：带 `di_` 前缀；顺序稳定，便于对照） */
export function candidatesFor(publicKeyB64Url) {
  return Object.entries(RULES).map(([rule, fn]) => ({ rule, id: withPrefix(fn(publicKeyB64Url)) }))
}

/** 按规则名派生；规则未给/未知一律抛错，绝不回退到随机值 */
export function deriveInstallationId(publicKeyB64Url, rule) {
  if (typeof publicKeyB64Url !== "string" || publicKeyB64Url.trim() === "") {
    throw new TypeError("deriveInstallationId: publicKey 必须是非空字符串")
  }
  const fn = RULES[String(rule ?? "")]
  if (!fn) throw new InstallationIdRuleUnknown(rule)
  return withPrefix(fn(publicKeyB64Url))
}

/**
 * 用一次真实观测值反推规则：返回命中的规则名，没命中返回 null。
 * 这是**验证**，不是猜测 —— 必须拿着真实 installationId 来比对。
 * 两侧都按「去前缀」比较：带不带 `di_` 不算规则差异（官方值带）。
 */
export function matchRule(publicKeyB64Url, observedInstallationId) {
  const observed = stripPrefix(observedInstallationId)
  const hit = Object.entries(RULES)
    .map(([rule, fn]) => ({ rule, id: fn(publicKeyB64Url) }))
    .find((item) => item.id === observed)
  return hit ? hit.rule : null
}
