// scripts/probe-rewards.mjs —— 看签到/奖励接口到底给不给我们 credit 与 streak
//
// 只读。用来确认 `auth.checkin` 的 `done` 分支能填哪两个字段（HOOKS 二）。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const authFile = homedir() + "/.config/magpie/plugin-auth.json"
const node = JSON.parse(readFileSync(authFile, "utf8")).phanthy ?? {}
const access = String(node.access || node.key || "").trim()
if (!access) {
  console.error("✖ magpie 里没有 phanthy 登录态")
  process.exit(2)
}

const H = {
  authorization: `Bearer ${access}`,
  "user-agent": "Bun/1.3.14",
  "x-phanthy-client-source": "desktop",
  accept: "application/json",
}

for (const path of ["/api/work/rewards?limit=5", "/api/work/daily-login", "/api/work/daily-login/status"]) {
  console.log(`======== GET ${path} ========`)
  let res
  try {
    res = await fetch(`https://code.phanthy.com${path}`, { headers: H })
  } catch (error) {
    console.log(`  网络错误: ${error.message}`)
    console.log("")
    continue
  }
  console.log(`  HTTP ${res.status}`)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    console.log(`  ${text.slice(0, 200)}`)
    console.log("")
    continue
  }
  console.log(`  顶层键: ${Object.keys(json).join(", ")}`)

  if (Array.isArray(json.rewards) && json.rewards.length > 0) {
    console.log("  rewards[0]:")
    console.log(JSON.stringify(json.rewards[0], null, 2).split("\n").map((l) => "    " + l).join("\n"))
  }

  // 找所有可能的「给多少积分」「连续多少天」字段
  const found = []
  const walk = (o, path2, depth) => {
    if (depth > 5 || !o || typeof o !== "object") return
    if (Array.isArray(o)) {
      o.forEach((x, i) => walk(x, `${path2}[${i}]`, depth + 1))
      return
    }
    for (const [k, v] of Object.entries(o)) {
      if (/point|credit|amount|streak|continuous|consecutive|day/i.test(k) && (typeof v === "number" || typeof v === "string")) {
        found.push(`${path2}.${k} = ${JSON.stringify(v)}`)
      }
      walk(v, `${path2}.${k}`, depth + 1)
    }
  }
  walk(json, "", 0)
  if (found.length) {
    console.log("  数值字段候选:")
    for (const f of found.slice(0, 25)) console.log(`    ${f}`)
  }
  console.log("")
}
