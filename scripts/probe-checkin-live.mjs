// scripts/probe-checkin-live.mjs —— 直接跑生产 checkin 钩子，看它给 magpie 的原始返回
//
// 只读（不设 PHANTHY_ALLOW_CHECKIN，走 status 分支）。认证从 magpie 的登录态取，
// 因为浏览器登录不会生成 `.credentials.json`。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"

import { PhanthyCodeAuthPlugin } from "../index.mjs"

const node = JSON.parse(readFileSync(homedir() + "/.config/magpie/plugin-auth.json", "utf8")).phanthy ?? {}
const access = String(node.access || node.key || "").trim()
if (!access) {
  console.error("✖ magpie 里没有 phanthy 登录态")
  process.exit(2)
}

const plugin = await PhanthyCodeAuthPlugin({}, { fetch: globalThis.fetch })
const out = await plugin.auth.checkin(
  async () => ({ type: "oauth", access, refresh: node.refresh, expires: node.expires, accountId: node.accountId, uid: node.uid }),
  { id: "phanthy" },
)

console.log("=== checkin 钩子返回（原样）===")
console.log(JSON.stringify(out, null, 2))
console.log("")

// 宿主会怎么读（`host-*.js` 的 checkinOf）
const num = (v) => (typeof v === "number" && isFinite(v) ? Math.max(0, v) : 0)
console.log("=== 宿主读到的 ===")
console.log(`  outcome : ${out.outcome}`)
console.log(`  credit  : ${num(out.credit)}`)
console.log(`  streak  : ${Math.round(num(out.streak))}`)
console.log(`  message : ${out.message ?? ""}`)
console.log("")
console.log(
  num(out.credit) > 0
    ? "  → 卡片会显示「今日已签到 +" + num(out.credit) + (num(out.streak) > 1 ? " · 连续 " + Math.round(num(out.streak)) + " 天" : "") + "」"
    : "  → credit 为 0，卡片大概率还是黄灯（拿不到今天给了多少）",
)
