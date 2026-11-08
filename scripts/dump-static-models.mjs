// scripts/dump-static-models.mjs —— 从真实目录生成 context.mjs 的静态兜底表
//
// 静态兜底只在「未登录 / 目录拉不到」时用，但**必须与真实目录同形**：
// 早期写死了 5 条（含两条根本不存在的 claude-*），用户没登录时看到的就是假列表。
//
// 输出可直接粘进 src/context.mjs 的 MODELS。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const authFile = homedir() + "/.config/magpie/plugin-auth.json"
const store = JSON.parse(readFileSync(authFile, "utf8"))
const entry = store.phanthycode ?? store.phanthy ?? {}
const access = String(entry.access || entry.key || "").trim()
if (!access) {
  console.error("✖ magpie 里没有登录态（phanthycode / phanthy 都没有）")
  process.exit(2)
}

const res = await fetch("https://code.phanthy.com/api/phanthy_code/models", {
  headers: {
    authorization: `Bearer ${access}`,
    "user-agent": "Bun/1.3.14",
    "x-phanthy-client-source": "desktop",
    accept: "application/json",
  },
})

if (!res.ok) {
  console.error(`✖ 目录 HTTP ${res.status}`)
  process.exit(3)
}

const body = await res.json()
const models = Array.isArray(body.models) ? body.models : []
if (models.length === 0) {
  console.error("✖ 目录是空的")
  process.exit(3)
}

console.log(`// 共 ${models.length} 条 · 默认 ${body.default_model ?? "(无)"}`)
console.log("export const MODELS = [")
for (const m of models) {
  const id = String(m.id ?? "").trim()
  if (!id) continue
  const label = String(m.label ?? m.alias ?? id).trim()
  const ctx = Number(m.context_window_tokens ?? m.context_window ?? 0)
  const effort = m.capabilities?.effort === true

  // 生成一行：["id", "显示名", 可选上下文, 可选 effort]
  const parts = [JSON.stringify(id), JSON.stringify(label)]
  if (effort) parts.push('"high"')
  console.log(`  [${parts.join(", ")}],${ctx ? ` // ${(ctx / 1_000_000).toFixed(0)}M` : ""}`)
}
console.log("]")
