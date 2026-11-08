// scripts/watch-usage.mjs —— 长窗口盯 current_plan.used_credits（权威口径）
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const a = JSON.parse(readFileSync(homedir() + "/.config/magpie/plugin-auth.json", "utf8")).phanthycode ?? {}
const H = {
  authorization: `Bearer ${a.access || a.key}`,
  "user-agent": "Bun/1.3.14",
  "x-phanthy-client-source": "desktop",
  accept: "application/json",
}

async function plan() {
  const r = await fetch("https://code.phanthy.com/api/oauth/usage", { headers: H })
  const j = await r.json()
  return j.current_plan ?? {}
}

const rounds = Number(process.argv[2]) || 12
const gapMs = Number(process.argv[3]) || 30000
let first = await plan()
console.log(`  起始  used=${first.used_credits}  remaining=${first.remaining_credits}`)
for (let i = 1; i <= rounds; i++) {
  await new Promise((r) => setTimeout(r, gapMs))
  const p = await plan()
  console.log(`  +${String(((i * gapMs) / 1000).toFixed(0)).padStart(4)}s  used=${p.used_credits}  remaining=${p.remaining_credits}`)
}
