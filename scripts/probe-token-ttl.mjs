// scripts/probe-token-ttl.mjs —— 令牌寿命到底是谁定的：服务端 expires_in，还是我们写死？
//
// 只读：调一次 `/oauth/token` 刷新，把**原始响应键**打出来（token 值一律脱敏），
// 并解出 JWT 的 `iat` / `exp` 做对照。
//
// ⚠ 这会轮换 refresh_token，所以刷完必须写回凭据文件 —— 直接复用 refresh-login 的实现。

import { readFileSync } from "node:fs"

import { CLIENT_ID, TOKEN_PATH } from "../src/oauth.mjs"
import { credentialsFile } from "../src/local-import.mjs"
import { BASE } from "../src/context.mjs"
import { fingerprint } from "../src/credential.mjs"

const config = JSON.parse(readFileSync(credentialsFile(), "utf8"))
const node = config.claudeAiOauth ?? {}
const refresh = String(node.refreshToken ?? "").trim()

console.log("======== 当前凭据里的 access token ========")
try {
  const p = JSON.parse(Buffer.from(String(node.accessToken).split(".")[1], "base64url").toString())
  console.log(`  载荷键 : ${Object.keys(p).join(", ")}`)
  console.log(`  iat    : ${new Date(p.iat * 1000).toISOString()}`)
  console.log(`  exp    : ${new Date(p.exp * 1000).toISOString()}`)
  console.log(`  寿命   : ${(p.exp - p.iat) / 60} 分钟  ← 由**服务端**写进 JWT`)
  console.log(`  本地 expiresAt : ${new Date(node.expiresAt).toISOString()}`)
  console.log(`  与 JWT exp 差  : ${((p.exp * 1000 - node.expiresAt) / 1000).toFixed(3)} 秒`)
} catch (error) {
  console.log(`  解不出来: ${error.message}`)
}

console.log("")
console.log("======== POST /oauth/token 的原始响应 ========")
const res = await fetch(`${BASE}${TOKEN_PATH}`, {
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    "user-agent": "Bun/1.3.14",
  },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }),
})

const text = await res.text()
console.log(`  HTTP ${res.status}`)
let json = null
try {
  json = JSON.parse(text)
} catch {
  console.log(`  (非 JSON) ${text.slice(0, 300)}`)
}

if (json) {
  console.log(`  响应顶层键: ${Object.keys(json).join(", ")}`)
  console.log("")
  for (const [key, value] of Object.entries(json)) {
    if (typeof value === "string" && /token/i.test(key)) {
      console.log(`    ${key.padEnd(16)} string(len=${value.length} sha8=${fingerprint(value).slice(0, 8)})`)
    } else {
      console.log(`    ${key.padEnd(16)} ${JSON.stringify(value)}`)
    }
  }
  console.log("")
  if (json.expires_in !== undefined) {
    console.log(`  >>> 服务端明确返回 expires_in = ${json.expires_in} 秒 = ${json.expires_in / 60} 分钟`)
  } else {
    console.log("  >>> 服务端**没有**返回 expires_in —— 那样才会用到代码里的回退值")
  }
  if (typeof json.access_token === "string") {
    try {
      const p = JSON.parse(Buffer.from(json.access_token.split(".")[1], "base64url").toString())
      if (p.iat && p.exp) {
        console.log(`  >>> 新 JWT 的 exp - iat = ${(p.exp - p.iat) / 60} 分钟`)
      }
    } catch {}
  }

  // ⚠ 这次调用轮换了 refresh_token —— 必须写回，否则桌面端下次启动会 invalid_grant
  if (typeof json.refresh_token === "string" && json.refresh_token) {
    const { writeFileSync, renameSync, chmodSync } = await import("node:fs")
    const file = credentialsFile()
    const current = JSON.parse(readFileSync(file, "utf8"))
    const next = {
      ...current,
      claudeAiOauth: {
        ...(current.claudeAiOauth ?? {}),
        accessToken: String(json.access_token),
        refreshToken: String(json.refresh_token),
        expiresAt: Date.now() + (Number(json.expires_in) > 0 ? Number(json.expires_in) : 1800) * 1000,
      },
    }
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    try {
      chmodSync(file, 0o600)
    } catch {}
    console.log("  ✓ 已把轮换后的 refresh_token 写回凭据文件（桌面端不受影响）")
  }
}

console.log("")
console.log("======== 代码里的回退常量（只在服务端不给 expires_in 时用）=========")
console.log("  src/oauth.mjs   DEFAULT_EXPIRES_IN = 1800  （30 分钟）")
console.log("  src/oauth-device.mjs:228  回退 28_800     （8 小时，只在构造 URL 的旧路径）")
console.log("  src/context.mjs REFRESH_LEAD_MS = 5 分钟   （提前续期窗口，不是寿命）")
console.log("  src/production-auth.mjs INFERENCE_TOKEN_REFRESH_LEAD_MS = 30 秒（推理令牌提前换票）")
