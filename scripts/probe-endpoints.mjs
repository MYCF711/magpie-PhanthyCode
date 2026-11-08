// scripts/probe-endpoints.mjs —— 逐个打数据面端点，打印**原始**响应（脱敏）
// 用法：node scripts/probe-endpoints.mjs [usage|rewards|profile|models|all]

import { readImportedAccess } from "../src/local-import.mjs"
import { fingerprint } from "../src/credential.mjs"

const BASE = "https://code.phanthy.com"
const UA = "Bun/1.3.14"
const which = process.argv[2] ?? "all"

const { access } = readImportedAccess()
console.log(`token: len=${access.length} sha8=${fingerprint(access).slice(0, 8)}\n`)

const ENDPOINTS = {
  usage: "/api/oauth/usage",
  rewards: "/api/work/rewards?limit=5",
  profile: "/api/oauth/profile",
  models: "/api/phanthy_code/models",
  summary: "/api/oauth/usage/summary",
}

function redact(value, depth = 0) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && value.length > 120) return `${value.slice(0, 40)}…(${value.length})`
    return value
  }
  if (depth > 3) return "…"
  if (Array.isArray(value)) return value.slice(0, 5).map((v) => redact(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (/token|secret|key|password|authorization/i.test(k)) out[k] = `(redacted ${typeof v})`
    else out[k] = redact(v, depth + 1)
  }
  return out
}

for (const [name, path] of Object.entries(ENDPOINTS)) {
  if (which !== "all" && which !== name) continue
  const url = `${BASE}${path}`
  console.log(`=== ${name}: GET ${path} ===`)
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${access}`,
        "user-agent": UA,
        "x-phanthy-client-source": "desktop",
        accept: "application/json",
      },
    })
    const text = await res.text()
    console.log(`  HTTP ${res.status} ${res.statusText}  ${text.length}B`)
    try {
      const json = JSON.parse(text)
      console.log("  " + JSON.stringify(redact(json), null, 2).split("\n").join("\n  "))
    } catch {
      console.log("  (非 JSON) " + text.slice(0, 400))
    }
  } catch (error) {
    console.log(`  请求失败: ${error?.name}: ${error?.message}`)
  }
  console.log()
}
