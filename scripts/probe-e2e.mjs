// scripts/probe-e2e.mjs —— 端到端证明：正确 installationId 下，自建三把密钥能否走通注册+推理
//
// 目的：在插件落地前先证明公式正确、且「自建密钥」这条路真能通（不依赖桌面端）。
//
// 链路：注册（三把密钥）→ activities/summary 取 desktop_inference_token → /v1/messages
//
// 失败会自动回退再试：
//   · device_signature 用 device 私钥 → 失败则用 identity 私钥
//   · x-desktop-signature 用 identity 私钥 → 失败则用 device 私钥

import { createHash, generateKeyPairSync, sign } from "node:crypto"

import { readImportedAccess } from "../src/local-import.mjs"
import { fingerprint } from "../src/credential.mjs"
import { fetchProfile } from "../src/phanthy-api.mjs"

const BASE = "https://code.phanthy.com"
const UA = "Bun/1.3.14"
const EDITION = "phanthy_work"
const PLATFORM = "windows"
const VERSION = "2.48.0"
const MODEL = process.argv[2] ?? "Phanthy-fast"

const b64url = (buf) => Buffer.from(buf).toString("base64url")
const sha256 = (input) => createHash("sha256").update(input).digest()
const sha256b64 = (input) => sha256(input).toString("base64url")
const now = () => String(Date.now())

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return {
    publicKey,
    privateKey,
    pub: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    // ed25519 SPKI DER = 12 字节头 + 32 字节裸公钥
    rawPub: publicKey.export({ format: "der", type: "spki" }).subarray(12),
  }
}

/** 已破解的公式：di_ + base64url(sha256(裸 32 字节公钥)) */
function installationIdFromPublicKey(publicKeyB64Url) {
  const der = Buffer.from(publicKeyB64Url, "base64url")
  const raw = der.subarray(12)
  if (raw.length !== 32) throw new Error(`裸公钥长度不是 32：${raw.length}`)
  return `di_${sha256b64(raw)}`
}

const identity = keypair()
const device = keypair()
const inference = keypair()
const installationId = installationIdFromPublicKey(identity.pub)

console.log("=== 自建三把密钥 ===")
console.log(`  identity  : ${identity.pub.slice(0, 24)}…`)
console.log(`  device    : ${device.pub.slice(0, 24)}…`)
console.log(`  inference : ${inference.pub.slice(0, 24)}…`)
console.log(`  installationId = ${installationId}`)
console.log()

// 自检：公式对抓包真值也成立
const KNOWN_PUB = "MCowBQYDK2VwAyEAW0H5wmGbfsy-5AL5jyN78WrmRw5J5pKUcopE29psQBA"
const KNOWN_ID = "di_CJN39yf0ubUxUOS5lPV9Cr0REAkE2D2F7H0Y0x7lnUk"
console.log(`公式自检: ${installationIdFromPublicKey(KNOWN_PUB) === KNOWN_ID ? "✓ 与实测值一致" : "✗ 不一致"}`)
console.log()

const { access } = readImportedAccess()
const authHeader = `Bearer ${access}`
console.log(`token len=${access.length} sha8=${fingerprint(access).slice(0, 8)}`)

const profile = await fetchProfile({ access }, { fetchImpl: globalThis.fetch })
const accountScope = String(profile?.account?.uuid ?? "")
console.log(`accountScope = ${accountScope}`)
console.log()

// ── 注册 ─────────────────────────────────────────────────────────────
function deviceCanonical({ scope, id, pub, sessionKeyPub, ts, nonce }) {
  return ["desktop-device-v1", scope, id, pub, sessionKeyPub, ts, nonce].join("\n")
}
function v1Canonical({ method, path, ts, nonce, bodyStr, idempotencyKey }) {
  return ["v1", method, path, ts, nonce, sha256b64(bodyStr), idempotencyKey].join("\n")
}

async function register(bindingKey, headerKey, label) {
  const ts = now()
  const nonce = b64url(Buffer.from(crypto.getRandomValues(new Uint8Array(24))))
  const deviceSig = sign(
    null,
    Buffer.from(
      deviceCanonical({
        scope: accountScope,
        id: installationId,
        pub: identity.pub,
        sessionKeyPub: inference.pub,
        ts,
        nonce,
      }),
      "utf8",
    ),
    bindingKey,
  ).toString("base64url")

  const body = {
    public_key: identity.pub,
    edition: EDITION,
    platform: PLATFORM,
    version: VERSION,
    device_public_key: device.pub,
    device_signature: deviceSig,
    inference_public_key: inference.pub,
  }
  const bodyStr = JSON.stringify(body)
  const idempotencyKey = `register:${installationId}`
  const headerSig = sign(
    null,
    Buffer.from(v1Canonical({ method: "POST", path: "/api/oauth/desktop-installations/register", ts, nonce, bodyStr, idempotencyKey }), "utf8"),
    headerKey,
  ).toString("base64url")

  const res = await fetch(`${BASE}/api/oauth/desktop-installations/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: authHeader,
      "user-agent": UA,
      "x-desktop-installation-id": installationId,
      "x-desktop-timestamp": ts,
      "x-desktop-nonce": nonce,
      "x-desktop-signature": headerSig,
      "idempotency-key": idempotencyKey,
    },
    body: bodyStr,
  })
  const text = await res.text()
  console.log(`  [${label}] HTTP ${res.status}  ${text.slice(0, 220)}`)
  return res.status
}

console.log("=== ① 注册 ===")
let ok = await register(device.privateKey, identity.privateKey, "device_sign+identity_header")
if (ok !== 200 && ok !== 201) {
  console.log("  回退：device_sign 用 identity、header 用 identity")
  ok = await register(identity.privateKey, identity.privateKey, "identity_sign+identity_header")
}
if (ok !== 200 && ok !== 201) {
  console.log("\n✗ 注册仍未通过，后续跳过。")
  process.exit(2)
}
console.log()

// ── 推理令牌 ─────────────────────────────────────────────────────────
console.log("=== ② activities/summary（取 desktop_inference_token）===")
const sTs = now()
const sNonce = b64url(Buffer.from(crypto.getRandomValues(new Uint8Array(24))))
const sBody = JSON.stringify({ inference_public_key: inference.pub })
const sSig = sign(
  null,
  Buffer.from(
    v1Canonical({ method: "POST", path: "/api/oauth/activities/summary", ts: sTs, nonce: sNonce, bodyStr: sBody, idempotencyKey: "" }),
    "utf8",
  ),
  identity.privateKey,
).toString("base64url")

const sRes = await fetch(`${BASE}/api/oauth/activities/summary`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json",
    authorization: authHeader,
    "user-agent": UA,
    "x-desktop-installation-id": installationId,
    "x-desktop-timestamp": sTs,
    "x-desktop-nonce": sNonce,
    "x-desktop-signature": sSig,
  },
  body: sBody,
})
const sText = await sRes.text()
console.log(`  HTTP ${sRes.status}`)
const inferred = (() => {
  try {
    return JSON.parse(sText)
  } catch {
    return {}
  }
})()
const inferenceToken = String(inferred?.desktop_inference_token ?? "").trim()
console.log(`  has token: ${Boolean(inferenceToken)}${inferenceToken ? ` (len=${inferenceToken.length})` : ""}`)
if (!inferenceToken) {
  console.log(`  body: ${sText.slice(0, 400)}`)
  process.exit(3)
}
console.log()

// ── 推理 ─────────────────────────────────────────────────────────────
console.log("=== ③ POST /v1/messages ===")
const body = JSON.stringify({
  model: MODEL,
  max_tokens: 32,
  messages: [{ role: "user", content: "只回四个字：链路已通" }],
})
const iTs = now()
const iNonce = b64url(Buffer.from(crypto.getRandomValues(new Uint8Array(24))))
const requestId = crypto.randomUUID()

const inferenceCanonical = [
  "desktop-inference-v2",
  "POST",
  "/v1/messages",
  iTs,
  iNonce,
  sha256b64(body),
  sha256b64(authHeader),
  sha256b64(inferenceToken),
  requestId,
  "",
  "",
  "",
].join("\n")

const iSig = sign(null, Buffer.from(inferenceCanonical, "utf8"), inference.privateKey).toString("base64url")

const iRes = await fetch(`${BASE}/v1/messages`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: authHeader,
    "user-agent": UA,
    "anthropic-version": "2023-06-01",
    "x-request-id": requestId,
    "x-phanthy-desktop-session": inferenceToken,
    "x-phanthy-proof-timestamp": iTs,
    "x-phanthy-proof-nonce": iNonce,
    "x-phanthy-proof-signature": iSig,
  },
  body,
})
const iText = await iRes.text()
console.log(`  HTTP ${iRes.status} ${iRes.statusText}`)
console.log(`  ${iText.slice(0, 800)}`)

if (iRes.status === 200) {
  console.log("\n🏁 端到端全通：自建三把密钥 + 正确 installationId ⇒ 推理可用。")
} else {
  console.log("\n推理未通，见上面错误体。")
}
