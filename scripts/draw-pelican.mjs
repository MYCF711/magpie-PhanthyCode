// scripts/draw-pelican.mjs —— 用指定模型画一只鹈鹕（SVG），并量它到底扣了多少积分
//
// 用法：node scripts/draw-pelican.mjs [model-id] [--out <file>]
//   默认模型 deepseek-v4.1-flash-1017
//
// 量法：请求前后的钱包快照差值（availablePoints / reservedPoints / 各来源池），
// 结算要时间，所以请求后轮询到读数稳定为止。

import { writeFileSync } from "node:fs"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { PhanthyCodeAuthPlugin } from "../index.mjs"

const args = process.argv.slice(2)
const model = args.find((a) => !a.startsWith("--")) ?? "deepseek-v4.1-flash-1017"
const outIdx = args.indexOf("--out")
const outFile = outIdx >= 0 ? args[outIdx + 1] : join("D:/AI/tmp", `pelican-${model.replace(/[^\w.-]/g, "_")}.html`)

// 认证：magpie 的插件登录态（浏览器登录只写这里）
//
// ⚠ 必须把**整个 auth 节点**交回插件，不能只传 `{type:"api", key}`：
//   `uidOf(auth)` 优先用 `auth.uid`，只给 key 会退化成「凭据指纹」，
//   而安装记录是按 `uid`（= accountScope 指纹）存的 —— 键对不上就找不到记录，
//   于是拿一把过期令牌去签名，服务端回 403 `request_not_authorized`。
function authNode() {
  const store = JSON.parse(readFileSync(join(homedir(), ".config", "magpie", "plugin-auth.json"), "utf8"))
  const node = store.phanthycode ?? store.phanthy ?? {}
  if (!String(node.access || node.key || "").trim()) throw new Error("magpie 里没有 phanthycode 登录态")
  return node
}

const auth = authNode()
const access = String(auth.access || auth.key || "").trim()
const H = {
  authorization: `Bearer ${access}`,
  "user-agent": "Bun/1.3.14",
  "x-phanthy-client-source": "desktop",
  accept: "application/json",
}

async function wallet() {
  const res = await fetch("https://code.phanthy.com/api/work/rewards?limit=5", { headers: H })
  if (!res.ok) throw new Error(`rewards HTTP ${res.status}`)
  const w = (await res.json()).wallet ?? {}
  return {
    available: Number(w.availablePoints ?? NaN),
    reserved: Number(w.reservedPoints ?? NaN),
    total: Number(w.totalPoints ?? NaN),
    subscription: Number(w.sourceSummaries?.subscription?.remainingPoints ?? NaN),
    campaign: Number(w.sourceSummaries?.campaign?.remainingPoints ?? NaN),
  }
}

/** 等到读数稳定（连续两次相同）或超时 */
async function settle(prev, { tries = 8, gapMs = 2500 } = {}) {
  let last = await wallet()
  for (let i = 0; i < tries; i++) {
    if (last.available === prev.available && last.reserved === prev.reserved) return last
    await new Promise((r) => setTimeout(r, gapMs))
    const next = await wallet()
    if (next.available === last.available && next.reserved === last.reserved) return next
    last = next
  }
  return last
}

const plugin = await PhanthyCodeAuthPlugin({}, { fetch: globalThis.fetch })
const loader = await plugin.auth.loader(async () => auth, { id: "phanthycode" })

console.log(`模型    : ${model}`)
const before = await wallet()
console.log(`请求前  : 可用 ${before.available} / 预留 ${before.reserved} / 体验版 ${before.subscription} / 活动 ${before.campaign}`)
console.log("")

const prompt = [
  "画一只鹈鹕（pelican）。",
  "用 SVG 画，要求：",
  "1. 只输出一个完整可用的 <svg> 元素，不要任何解释、不要 markdown 代码块",
  "2. viewBox 用 0 0 400 400，画面里要能看出是鹈鹕：大嘴、喉囊、身体、翅膀、脚",
  "3. 用纯 SVG 图形（path / circle / ellipse / polygon），不要外部图片",
  "4. 配色和谐，加个简单的背景",
].join("\n")

const t0 = Date.now()
const res = await loader.fetch(loader.baseURL + "/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model,
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  }),
})
const text = await res.text()
const ms = Date.now() - t0

let parsed = null
try {
  parsed = JSON.parse(text)
} catch {}

console.log(`HTTP    : ${res.status}   ${(ms / 1000).toFixed(1)}s`)
if (!parsed?.usage) {
  console.log(`响应    : ${text.slice(0, 400)}`)
  process.exit(1)
}

console.log(`实际模型: ${parsed.model}`)
console.log(`token   : in=${parsed.usage.input_tokens} out=${parsed.usage.output_tokens}`)
console.log(`stop    : ${parsed.stop_reason}`)

const answer = (parsed.content ?? [])
  .map((c) => (c.type === "thinking" ? "" : c.text ?? ""))
  .join("")
  .trim()

// 抠出 <svg>…</svg>
const m = answer.match(/<svg[\s\S]*?<\/svg>/i)
const svg = m ? m[0] : ""

console.log(`输出长度: ${answer.length} 字符（SVG ${svg.length} 字符）`)
console.log("")

// 落一份能直接打开看的 HTML
writeFileSync(
  outFile,
  `<!doctype html><meta charset="utf-8"><title>${model} · 鹈鹕</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#1b1d21;color:#ddd;font:14px/1.6 system-ui}
main{max-width:640px;padding:24px}svg{width:100%;height:auto;background:#fff;border-radius:12px}
pre{white-space:pre-wrap;word-break:break-all;color:#8b949e;font-size:12px;max-height:220px;overflow:auto}</style>
<main>
<h3>${model}</h3>
<div>${svg || "<em>模型没有返回可用的 &lt;svg&gt;</em>"}</div>
<details><summary>原始输出</summary><pre>${answer.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])}</pre></details>
</main>`,
  "utf8",
)
console.log(`已写入  : ${outFile}`)
console.log("")

const after = await settle(before)
console.log(`请求后  : 可用 ${after.available} / 预留 ${after.reserved} / 体验版 ${after.subscription} / 活动 ${after.campaign}`)
console.log("")
const d = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? a - b : NaN)
console.log("======== 积分变化 ========")
console.log(`  可用    : ${d(after.available, before.available)}`)
console.log(`  预留    : ${d(after.reserved, before.reserved)}`)
console.log(`  体验版  : ${d(after.subscription, before.subscription)}`)
console.log(`  活动    : ${d(after.campaign, before.campaign)}`)
