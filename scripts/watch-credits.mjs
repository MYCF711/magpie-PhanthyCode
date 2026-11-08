// scripts/watch-credits.mjs —— 盯着钱包看结算什么时候落地
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const a = JSON.parse(readFileSync(homedir() + "/.config/magpie/plugin-auth.json", "utf8")).phanthycode ?? {}
const H = {
  authorization: `Bearer ${a.access || a.key}`,
  "user-agent": "Bun/1.3.14",
  "x-phanthy-client-source": "desktop",
  accept: "application/json",
}

async function snap() {
  const r = await fetch("https://code.phanthy.com/api/work/rewards?limit=5", { headers: H })
  const w = (await r.json()).wallet ?? {}
  return {
    available: w.availablePoints,
    reserved: w.reservedPoints,
    sub: w.sourceSummaries?.subscription?.remainingPoints,
    camp: w.sourceSummaries?.campaign?.remainingPoints,
  }
}

const rounds = Number(process.argv[2]) || 6
const gapMs = Number(process.argv[3]) || 10000

console.log("现在   :", JSON.stringify(await snap()))
for (let i = 1; i <= rounds; i++) {
  await new Promise((r) => setTimeout(r, gapMs))
  console.log(`+${((i * gapMs) / 1000).toFixed(0)}s`.padEnd(7) + ":", JSON.stringify(await snap()))
}
