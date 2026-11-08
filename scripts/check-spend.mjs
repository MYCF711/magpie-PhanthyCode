// scripts/check-spend.mjs —— 权威口径：/api/oauth/usage 的 current_plan.used_credits
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const a = JSON.parse(readFileSync(homedir() + "/.config/magpie/plugin-auth.json", "utf8")).phanthycode ?? {}
const H = {
  authorization: `Bearer ${a.access || a.key}`,
  "user-agent": "Bun/1.3.14",
  "x-phanthy-client-source": "desktop",
  accept: "application/json",
}

for (const path of ["/api/oauth/usage", "/api/work/rewards?limit=5"]) {
  const res = await fetch(`https://code.phanthy.com${path}`, { headers: H })
  const json = await res.json()
  console.log(`======== ${path} → HTTP ${res.status} ========`)
  if (path.includes("usage")) {
    for (const [k, v] of Object.entries(json)) {
      if (v && typeof v === "object" && "used_credits" in v) {
        console.log(`  ${k}: used=${v.used_credits} remaining=${v.remaining_credits} total=${v.total_credits} pct=${v.remaining_percentage}`)
      }
    }
  } else {
    const w = json.wallet ?? {}
    console.log(`  wallet: available=${w.availablePoints} reserved=${w.reservedPoints} balance=${w.balancePoints} total=${w.totalPoints}`)
    console.log(`  sub=${w.sourceSummaries?.subscription?.remainingPoints}/${w.sourceSummaries?.subscription?.totalPoints} used=${w.sourceSummaries?.subscription?.usedPoints}`)
    console.log(`  camp=${w.sourceSummaries?.campaign?.remainingPoints}/${w.sourceSummaries?.campaign?.totalPoints} used=${w.sourceSummaries?.campaign?.usedPoints}`)
  }
  console.log("")
}
