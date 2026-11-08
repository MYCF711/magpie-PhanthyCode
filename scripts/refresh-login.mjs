// scripts/refresh-login.mjs —— 直接刷新本机 OAuth 登录态（不重启桌面端）
//
// 为什么需要：桌面端一启动就会把 `.credentials.json` 的 access token 刷到新值，
// 但**没必要为此启停它** —— 插件自己就有 `refreshAccessToken()`（RFC 6749 §6，
// `POST /oauth/token` + `grant_type=refresh_token`）。
//
// ⚠ 这会轮换 refresh_token（服务端一次性轮换），所以刷完必须**写回原文件**，
//   否则桌面端下次启动会 invalid_grant。
//
// 用法：node scripts/refresh-login.mjs
// 输出：只打印长度与剩余时间，绝不打印 token 值。

import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { refreshAccessToken } from "../src/oauth-device.mjs"
import { CLIENT_ID, TOKEN_PATH } from "../src/oauth.mjs"
import { credentialsFile } from "../src/local-import.mjs"
import { BASE } from "../src/context.mjs"
import { fingerprint } from "../src/credential.mjs"

const file = credentialsFile()
const raw = readFileSync(file, "utf8")
const config = JSON.parse(raw)
const node = config.claudeAiOauth
if (!node || typeof node !== "object") {
  console.error(`✗ ${file} 里没有 claudeAiOauth 节点`)
  process.exit(2)
}

const refresh = String(node.refreshToken ?? "").trim()
if (!refresh) {
  console.error("✗ 凭据里没有 refreshToken，只能走浏览器 OAuth")
  process.exit(2)
}

const before = Number(node.expiresAt)
const left = Number.isFinite(before) ? Math.round((before - Date.now()) / 1000) : null
console.log(`凭据文件 : ${file}`)
console.log(`当前 token: len=${String(node.accessToken ?? "").length} sha8=${fingerprint(String(node.accessToken ?? "")).slice(0, 8)}`)
console.log(`过期情况 : ${left === null ? "未知" : left <= 0 ? `已过期 ${Math.abs(left)} 秒` : `剩 ${left} 秒`}`)
console.log(`刷新端点 : ${BASE}${TOKEN_PATH}`)
console.log()

const out = await refreshAccessToken({
  refresh,
  tokenUrl: `${BASE}${TOKEN_PATH}`,
  clientId: CLIENT_ID,
  fetchImpl: globalThis.fetch,
})

if (!out) {
  console.error("✗ 刷新失败（网络错误 / 5xx / 响应里没有 access_token）")
  process.exit(3)
}

// 写回：临时文件 + 改名（原子），权限 0600
const next = {
  ...config,
  claudeAiOauth: {
    ...node,
    accessToken: out.access,
    refreshToken: out.refresh,
    expiresAt: out.expires,
  },
}
const tmp = `${file}.${process.pid}.tmp`
writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
renameSync(tmp, file)
try {
  chmodSync(file, 0o600)
} catch {}

const after = Math.round((out.expires - Date.now()) / 1000)
console.log("✓ 已刷新并写回")
console.log(`  新 token: len=${out.access.length} sha8=${fingerprint(out.access).slice(0, 8)}`)
console.log(`  剩余    : ${after} 秒（约 ${Math.round(after / 60)} 分钟）`)
console.log(`  refresh ${out.refresh === refresh ? "未轮换（沿用旧值）" : "已轮换（新值已写回）"}`)
