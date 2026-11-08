// scripts/spend-curve.mjs —— 摸「每 token 花多少积分」的成本曲线
//
// 只认 `/api/oauth/usage` 的 `current_plan.used_credits`（服务端累计已用，只增不减）。
// 每轮：读 used → 发一次请求 → 等结算 → 再读 used。
//
// 为什么先做曲线而不是直接烧 1M：1M 输出按当前费率约 500 积分，
// 而账号只有 ~1965。先用小样本拟合出单价，再把 1M 的成本算出来。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"

import { PhanthyCodeAuthPlugin } from "../index.mjs"

const store = JSON.parse(readFileSync(homedir() + "/.config/magpie/plugin-auth.json", "utf8"))
const auth = store.phanthycode ?? {}
const H = {
  authorization: `Bearer ${auth.access || auth.key}`,
  "user-agent": "Bun/1.3.14",
  "x-phanthy-client-source": "desktop",
  accept: "application/json",
}

async function used() {
  const res = await fetch("https://code.phanthy.com/api/oauth/usage", { headers: H })
  const json = await res.json()
  const p = json.current_plan ?? {}
  return { used: Number(p.used_credits), remaining: Number(p.remaining_credits) }
}

/** 等 used_credits 稳定：连续两次相同且给了至少一次结算窗口 */
async function settle(prev, { tries = 12, gapMs = 4000 } = {}) {
  await new Promise((r) => setTimeout(r, gapMs))
  let last = await used()
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, gapMs))
    const next = await used()
    if (next.used === last.used) return next
    last = next
  }
  return last
}

const plugin = await PhanthyCodeAuthPlugin({}, { fetch: globalThis.fetch })
const loader = await plugin.auth.loader(async () => auth, { id: "phanthycode" })

// 用「数数」把输出长度钉住：模型数到 N 就用掉大约那么多 token
const sizes = [200, 800, 2000, 4000, 8000]
const model = process.argv[2] ?? "deepseek-v4.1-flash-1017"

console.log(`模型: ${model}`)
console.log(`起始: ${JSON.stringify(await used())}`)
console.log("")
console.log("  max_tokens   in      out     消耗   每千输出token")
console.log("  " + "-".repeat(58))

const rows = []
for (const size of sizes) {
  const before = await used()
  const t0 = Date.now()
  const res = await loader.fetch(loader.baseURL + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: size,
      messages: [{ role: "user", content: `从 1 开始依次写出阿拉伯数字，每行一个，一直写到 ${size} 为止。不要任何解释。` }],
    }),
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {}

  if (!parsed?.usage) {
    console.log(`  ${String(size).padStart(8)}   HTTP ${res.status}  ${text.slice(0, 80)}`)
    continue
  }

  const after = await settle(before)
  const delta = after.used - before.used
  const out = Number(parsed.usage.output_tokens) || 0
  const per1k = out > 0 ? ((delta / out) * 1000).toFixed(4) : "—"
  rows.push({ size, in: parsed.usage.input_tokens, out, delta, ms: Date.now() - t0 })
  console.log(
    `  ${String(size).padStart(8)}   ${String(parsed.usage.input_tokens).padStart(5)}  ${String(out).padStart(7)}  ${String(delta).padStart(6)}   ${String(per1k).padStart(10)}   (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
  )
}

console.log("")
const billed = rows.filter((r) => r.delta > 0 && r.out > 0)
if (billed.length > 0) {
  const totalOut = billed.reduce((s, r) => s + r.out, 0)
  const totalDelta = billed.reduce((s, r) => s + r.delta, 0)
  const perM = (totalDelta / totalOut) * 1_000_000
  console.log(`拟合（只用有扣费的样本）：`)
  console.log(`  ${totalDelta} 积分 / ${totalOut} 输出 token`)
  console.log(`  → 每 100 万输出 token ≈ ${perM.toFixed(0)} 积分`)
  console.log(`  → 1,000,000 输出 token ≈ ${perM.toFixed(0)} 积分`)
  console.log("")
  console.log(`对照：当前剩余 ${(await used()).remaining} 积分`)
} else {
  console.log("没有样本产生扣费，拟合不出来（费率可能低于抹零阈值）")
}
