// scripts/model-limits.mjs —— 这个模型到底允许多大输出 / 多长上下文
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const store = JSON.parse(readFileSync(homedir() + "/.config/magpie/plugin-auth.json", "utf8"))
const auth = store.phanthycode ?? {}
const H = {
  authorization: `Bearer ${auth.access || auth.key}`,
  "user-agent": "Bun/1.3.14",
  "x-phanthy-client-source": "desktop",
  accept: "application/json",
}

const res = await fetch("https://code.phanthy.com/api/phanthy_code/models", { headers: H })
const body = await res.json()
const target = process.argv[2] ?? "deepseek-v4.1-flash-1017"

console.log("======== 目录里所有与「长度」有关的字段 ========")
for (const m of body.models ?? []) {
  if (m.id !== target) continue
  console.log(`  id: ${m.id}`)
  for (const [k, v] of Object.entries(m)) {
    if (/context|token|limit|max|length|window|output/i.test(k)) {
      console.log(`    ${k} = ${JSON.stringify(v)}`)
    }
  }
  console.log("    完整键:", Object.keys(m).join(", "))
}
console.log("")
console.log("======== 全部模型的关键字段（对比用）========")
console.log("  " + "id".padEnd(28) + "context".padStart(10) + "max_out".padStart(10))
for (const m of body.models ?? []) {
  const ctx = m.context_window_tokens ?? m.context_window ?? ""
  const out = m.max_output_tokens ?? m.max_tokens ?? m.output_tokens ?? ""
  console.log("  " + String(m.id).padEnd(28) + String(ctx).padStart(10) + String(out).padStart(10))
}
