// scripts/probe-inference.mjs —— 测 /v1/messages：只带 Bearer 能不能出字
//
// 用途：判断「设备注册 + 推理令牌」到底是不是推理面的**硬前提**。
//   · 200 且出字  → 只要 OAuth Bearer 就够，loader 里的设备注册链是多余的硬门槛
//   · 401/403/409 → 服务端确实要 x-desktop-* 签名，注册是硬前提
//
// 边界：最小请求（max_tokens=1 起，失败再试 8），不打印 token。

import { readImportedAccess } from "../src/local-import.mjs"
import { fingerprint } from "../src/credential.mjs"

const BASE = "https://code.phanthy.com"
const UA = "Bun/1.3.14"
const MODEL = process.argv[2] ?? "Phanthy-fast"

const { access } = readImportedAccess()
console.log(`token: len=${access.length} sha8=${fingerprint(access).slice(0, 8)}`)
console.log(`model: ${MODEL}\n`)

const body = {
  model: MODEL,
  max_tokens: 16,
  messages: [{ role: "user", content: "ping" }],
}

console.log("=== POST /v1/messages（只带 Bearer） ===")
const res = await fetch(`${BASE}/v1/messages`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${access}`,
    "user-agent": UA,
    "x-phanthy-client-source": "desktop",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
})

const text = await res.text()
console.log(`HTTP ${res.status} ${res.statusText}  ${text.length}B`)
console.log("响应头里的 x-*:")
for (const [k, v] of res.headers) if (k.toLowerCase().startsWith("x-")) console.log(`  ${k}: ${v}`)
console.log()
try {
  const json = JSON.parse(text)
  const redacted = JSON.stringify(json, (k, v) =>
    /token|secret|key|password|authorization|signature/i.test(k) ? "(redacted)" : v, 2)
  console.log(redacted.slice(0, 2000))
} catch {
  console.log(text.slice(0, 1500))
}
