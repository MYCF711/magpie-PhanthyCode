// src/proof.mjs —— 设备证明与请求签名（纯函数 + ed25519 原语）
//
// 这个文件只做三件事，不做任何 IO、不发请求、不认识任何端点：
//   ① 三条 canonical 串的拼装（分隔符不同，是三条独立的串）
//   ② sha256 → base64url
//   ③ ed25519 签名 / 验签 / 公钥编码（SPKI/DER → base64url）
//
// ── 三条 canonical（全部 base64url、全部取自原始字节）─────────────────
//
//   device（register 的 body.device_signature）—— **LF 连接**，7 段：
//     desktop-device-v1 ⏎ accountScope ⏎ installationId ⏎ publicKey
//     ⏎ sessionKeyPublicKey ⏎ timestamp ⏎ nonce
//
//   v1（请求头 x-desktop-signature）—— **LF 连接**，7 段：
//     v1 ⏎ method ⏎ upstreamPath ⏎ timestamp ⏎ nonce
//     ⏎ b64url(sha256(最终 body 字符串)) ⏎ idempotencyKey
//
//   inference（请求头 x-phanthy-proof-signature）—— **LF 连接**，12 段：
//     desktop-inference-v2 ⏎ METHOD(大写) ⏎ pathname ⏎ timestamp ⏎ nonce
//     ⏎ b64url(sha256(rawBody)) ⏎ b64url(sha256(Authorization 完整头值))
//     ⏎ b64url(sha256(desktop_inference_token)) ⏎ x-request-id
//     ⏎ x-claude-code-session-id ⏎ x-phanthy-expert-id ⏎ x-phanthy-skill-names
//
// 证据（全部按原始字节，不看渲染）：
//   · `_up_\dist\assets\App-Y9eSJNhB.js` @101092 / @101391 —— device 与 v1 两条
//     都是 `].join(` + 0x0A + `)`；
//   · `claude-sidecar.exe` @99904271（`rw8` / `desktop-inference-v2` 那一段）
//     同样 `5D 2E 6A 6F 69 6E 28 60 0A 60 29` —— **三条全部 LF 连接**。
//   渲染工具会把 0x0A 显示成「点」或空格（我第一次就把它读成点号），所以
//   这一处只能看 hex。12 段里缺项写空串，但分隔符不能省。
//
// ⚠ 两条容易写错、写错必签名失败的细节：
//   ① v1 串里的 method 保持原值（`POST`），只有 inference 串才 toUpperCase()；
//   ② v1 / inference 里的 body 摘要是**注入完字段之后的最终字符串**，
//      所以调用方必须先序列化、再签名、再原样发出，不能中途再 JSON.stringify。

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from "node:crypto"

/** device 绑定串的前缀 */
export const DEVICE_PREFIX = "desktop-device-v1"

/** 通用请求头签名串的前缀 */
export const V1_PREFIX = "v1"

/** 推理证明串的前缀 */
export const INFERENCE_PREFIX = "desktop-inference-v2"

/** 签名算法：ed25519（不是 RSA） */
export const SIGNATURE_ALGORITHM = "ed25519"

/** canonical 的分隔符：device / v1 用 LF */
export const LF = "\n"

/** canonical 的分隔符：三条串一致，全部 LF */
export const CANONICAL_SEPARATOR = LF

/**
 * sha256 → base64url（无 padding）。
 * 字符串按 UTF-8 编码；Uint8Array 按原字节。空串的摘要是固定值
 * `47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU`（GET 请求没有 body 时用它）。
 */
export function sha256B64Url(value) {
  const bytes =
    typeof value === "string"
      ? Buffer.from(value, "utf8")
      : value instanceof Uint8Array
        ? Buffer.from(value)
        : Buffer.from("")
  return createHash("sha256").update(bytes).digest("base64url")
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} 必须是非空字符串`)
  }
  return value
}

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value)
}

/**
 * 设备绑定 canonical。7 段全部必填 —— 任何一段为空都是调用方的 bug，
 * 空串会让签名与服务端算出来的串不一致，表现为 `desktop_binding_invalid`。
 */
export function deviceCanonical({
  accountScope,
  installationId,
  publicKey,
  sessionKeyPublicKey,
  timestamp,
  nonce,
} = {}) {
  const segments = [
    requiredString(accountScope, "deviceCanonical: accountScope"),
    requiredString(installationId, "deviceCanonical: installationId"),
    requiredString(publicKey, "deviceCanonical: publicKey"),
    requiredString(sessionKeyPublicKey, "deviceCanonical: sessionKeyPublicKey"),
    requiredString(String(timestamp ?? ""), "deviceCanonical: timestamp"),
    requiredString(nonce, "deviceCanonical: nonce"),
  ]
  return [DEVICE_PREFIX, ...segments].join(LF)
}

/**
 * 通用请求头签名 canonical。`body` 传字符串原样摘要（GET 传 `""`）。
 *
 * `idempotencyKey` **可以为空**：`activities/summary` 这类请求没有幂等键，
 * canonical 第 7 段就是空串（分隔符仍然保留）。`register` 必须给非空值 ——
 * 那由 `src/registration.mjs` 的 `idempotencyKeyFor` 保证，不在这一层替它兜。
 */
export function v1Canonical({ method, upstreamPath, timestamp, nonce, body = "", idempotencyKey = "" } = {}) {
  const segments = [
    requiredString(method, "v1Canonical: method"),
    requiredString(upstreamPath, "v1Canonical: upstreamPath"),
    requiredString(String(timestamp ?? ""), "v1Canonical: timestamp"),
    requiredString(nonce, "v1Canonical: nonce"),
    sha256B64Url(body ?? ""),
    optionalString(idempotencyKey),
  ]
  return [V1_PREFIX, ...segments].join(LF)
}

/**
 * 推理证明 canonical（12 段，LF 连接）。
 *
 * 前 7 段必填；后 4 段（session / expert / skills）在请求没有对应头时写空串，
 * 但**分隔符必须保留** —— 少一段或多一段都会变成另一个串。
 */
export function inferenceCanonical({
  method,
  pathname,
  timestamp,
  nonce,
  body = "",
  authorization,
  inferenceToken,
  requestId,
  sessionId = "",
  expertId = "",
  skillNames = "",
} = {}) {
  const head = [
    requiredString(String(method ?? "").toUpperCase(), "inferenceCanonical: method"),
    requiredString(pathname, "inferenceCanonical: pathname"),
    requiredString(String(timestamp ?? ""), "inferenceCanonical: timestamp"),
    requiredString(nonce, "inferenceCanonical: nonce"),
    sha256B64Url(body ?? ""),
    sha256B64Url(requiredString(authorization, "inferenceCanonical: authorization")),
    sha256B64Url(requiredString(inferenceToken, "inferenceCanonical: inferenceToken")),
    requiredString(requestId, "inferenceCanonical: requestId"),
  ]
  const tail = [optionalString(sessionId), optionalString(expertId), optionalString(skillNames)]
  return [INFERENCE_PREFIX, ...head, ...tail].join(LF)
}

// ── ed25519 原语 ──────────────────────────────────────────────────────

/** 公钥编码：SPKI / DER / base64url（服务端比对的就是这个串） */
export function spkiB64Url(publicKey) {
  return publicKey.export({ format: "der", type: "spki" }).toString("base64url")
}

/** 私钥编码：PKCS#8 / DER / base64url（只给本机存储用，绝不发出去） */
export function exportPrivateKey(privateKey) {
  return privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")
}

/** 从 base64url 的 PKCS#8 DER 还原私钥 */
export function importPrivateKey(encoded) {
  requiredString(encoded, "importPrivateKey: encoded")
  return createPrivateKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "pkcs8" })
}

/** 从 base64url 的 SPKI DER 还原公钥 */
export function importPublicKey(encoded) {
  requiredString(encoded, "importPublicKey: encoded")
  return createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" })
}

/** 生成一把 ed25519 身份密钥 */
export function generateEd25519KeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync(SIGNATURE_ALGORITHM)
  return {
    publicKey,
    privateKey,
    publicKeyB64Url: spkiB64Url(publicKey),
    privateKeyB64Url: exportPrivateKey(privateKey),
  }
}

/**
 * 签一条 canonical。node:crypto 的 ed25519 走 `sign(null, data, key)`
 * —— 算法参数必须是 null（ed25519 没有单独的摘要参数）。
 */
export function signCanonical(privateKey, canonical) {
  requiredString(canonical, "signCanonical: canonical")
  return sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url")
}

/** 验签（测试用它做 sign → verify 往返自证，生产路径不依赖它） */
export function verifyCanonical(publicKey, canonical, signatureB64Url) {
  try {
    return verify(
      null,
      Buffer.from(String(canonical), "utf8"),
      publicKey,
      Buffer.from(String(signatureB64Url), "base64url"),
    )
  } catch {
    return false
  }
}

/** nonce：24 字节随机数的 base64url，够长且无需协商格式 */
export function randomNonce(bytes = 24) {
  if (!Number.isInteger(bytes) || bytes <= 0) throw new TypeError("randomNonce: bytes 必须是正整数")
  return randomBytes(bytes).toString("base64url")
}

/** 请求 id：uuid v4 */
export function randomRequestId() {
  return randomUUID()
}

/** 时间戳：毫秒数字的字符串（服务端看到的 `ts`） */
export function timestampNow(now = Date.now) {
  return String(now())
}
