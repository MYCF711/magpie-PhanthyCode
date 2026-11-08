// scripts/measure-spend.mjs —— 用**权威口径**（/api/oauth/usage 的 used_credits）量一次请求花多少
//
// 为什么不用 availablePoints：它会随「预留 / 结算」上下浮动，子智能体实测到 ±1~3 的噪声，
// 于是「每次 −1」很可能全是噪声。used_credits 是服务端结算后的**累计已用**，只增不减。
//
// 用法：node scripts/measure-spend.mjs [model] [maxTokens] [prompt]

import { readFileSync } from "node:fs"
import { homedir } from "node:os"

import { PhanthyCodeAuthPlugin } from "../index.mjs"

const model = process.argv[2] ?? "deepseek-v4.1-flash-1017"
const maxTokens = Number(process.argv[3]) || 64
const prompt = process.argv[4] ?? "用一句中文说：消耗测试"

const store = JSON.parse(readFileSync(homedir() + "/.config/magpie/plugin-auth.json", "utf8"))
const auth = store.phanthycode ?? store.phanthy ?? {}
const H = {
  authorization: `Bearer ${auth.access || auth.key}`,
  "user-agent": "Bun/1.3.14",
  "x-phanthy-client-source": "desktop",
  accept: "application/json",
}

async function used() {
  const res = await fetch("https://code.phanthy.com/api/oauth/usage", { headers: H })
  if (!res.ok) throw new Error(`usage HTTP ${res.status}`)
  const json = await res.json()
  const plan = json.current_plan ?? {}
  return {
    used: Number(plan.used_credits),
    remaining: Number(plan.remaining_credits),
    total: Number(plan.total_credits),
  }
}

/** 等 used_credits 稳定（连续两次相同），最多等 tries*gap */
async function settle(prev, { tries = 20, gapMs = 6000 } = {}) {
  let last = await used()
  for (let i = 0; i < tries; i++) {
    if (last.used !== prev.used) {
      const next = await used()
      if (next.used === last.used) return last
      last = next
      continue
    }
    await new Promise((r) => setTimeout(r, gapMs))
    const next = await used()
    if (next.used === last.used) return last
    last = next
  }
  return last
}

const plugin = await PhanthyCodeAuthPlugin({}, { fetch: globalThis.fetch })
const loader = await plugin.auth.loader(async () => auth, { id: "phanthycode" })

const before = await used()
console.log(`模型    : ${model}   max_tokens=${maxTokens}`)
console.log(`请求前  : used=${before.used}  remaining=${before.remaining}  total=${before.total}`)

const t0 = Date.now()
const res = await loader.fetch(loader.baseURL + "/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
})
const text = await res.text()
let parsed = null
try {
  parsed = JSON.parse(text)
} catch {}

console.log(`HTTP    : ${res.status}   ${((Date.now() - t0) / 1000).toFixed(1)}s`)
if (!parsed?.usage) {
  console.log(`响应    : ${text.slice(0, 300)}`)
  process.exit(1)
}
console.log(`实际模型: ${parsed.model}`)
console.log(`token   : in=${parsed.usage.input_tokens} out=${parsed.usage.output_tokens}`)
console.log("")

const after = await settle(before)
console.log(`请求后  : used=${after.used}  remaining=${after.remaining}  total=${after.total}`)
console.log("")
console.log(`======== 本次消耗：${after.used - before.used} 积分 ========`)
