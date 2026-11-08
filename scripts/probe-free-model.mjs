// scripts/probe-free-model.mjs —— 测「这个模型一次请求到底扣不扣积分」
//
// 用法：node scripts/probe-free-model.mjs <model-id> [--json]
//
// 量法：钱包 availablePoints 的差值。
//   · 请求前取一次 → 发一次 max_tokens=24 的请求 → 等结算 → 再取一次
//   · 同时读 reservedPoints（服务端用「预留」占位，结算后归还）
//
// ⚠ 只能**串行**跑：积分是账号级的，两个模型同时测会互相污染。
//   脚本自己带一把文件锁（.probe-lock），并发的调用会排队。

import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { readImportedAccess } from "../src/local-import.mjs"
import { PhanthyCodeAuthPlugin } from "../index.mjs"

const model = process.argv[2]
const asJson = process.argv.includes("--json")
if (!model) {
  console.error("用法: node scripts/probe-free-model.mjs <model-id> [--json]")
  process.exit(2)
}

const LOCK = join(process.cwd(), ".probe-lock")
const LOCK_STALE_MS = 120_000

async function acquireLock() {
  const deadline = Date.now() + LOCK_STALE_MS
  while (Date.now() < deadline) {
    if (!existsSync(LOCK)) {
      writeFileSync(LOCK, `${process.pid}\n`, { flag: "wx" })
      return true
    }
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS) unlinkSync(LOCK)
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function releaseLock() {
  try {
    unlinkSync(LOCK)
  } catch {}
}

const log = (msg) => {
  if (!asJson) console.log(msg)
}

// 认证来源二选一：
//   ① 本机凭据文件（桌面端登录过）
//   ② magpie 自己存的插件登录态 `~/.config/magpie/plugin-auth.json`
//      —— 浏览器登录只写这里，`.credentials.json` 不存在。
//   只读，绝不回写 magpie 的目录。
function accessFromMagpie() {
  const file = join(homedir(), ".config", "magpie", "plugin-auth.json")
  if (!existsSync(file)) return ""
  const node = JSON.parse(readFileSync(file, "utf8"))?.phanthy ?? {}
  return String(node.access || node.key || "").trim()
}

function accessToken() {
  try {
    const { access } = readImportedAccess()
    if (access) return access
  } catch {}
  const fromMagpie = accessFromMagpie()
  if (fromMagpie) return fromMagpie
  throw new Error("拿不到 access token：本机凭据与 magpie 登录态都没有")
}

const access = accessToken()

// 认证走插件的 loader；注册记录已经存在（0.2.15 起默认允许注册）
const plugin = await PhanthyCodeAuthPlugin({}, { fetch: globalThis.fetch })
const loader = await plugin.auth.loader(async () => ({ type: "api", key: access }), { id: "phanthy" })

const H = {
  authorization: `Bearer ${access}`,
  "user-agent": "Bun/1.3.14",
  "x-phanthy-client-source": "desktop",
  accept: "application/json",
}

async function wallet() {
  const res = await fetch("https://code.phanthy.com/api/work/rewards?limit=5", { headers: H })
  if (!res.ok) throw new Error(`rewards HTTP ${res.status}`)
  const body = await res.json()
  const w = body.wallet ?? {}
  return {
    available: Number(w.availablePoints ?? NaN),
    reserved: Number(w.reservedPoints ?? NaN),
    total: Number(w.totalPoints ?? NaN),
    subscription: Number(w.sourceSummaries?.subscription?.remainingPoints ?? NaN),
    campaign: Number(w.sourceSummaries?.campaign?.remainingPoints ?? NaN),
  }
}

const got = await acquireLock()
if (!got) {
  console.error("✖ 抢不到测量锁（另一个测量还在跑）")
  process.exit(3)
}

try {
  const before = await wallet()
  log(`模型      : ${model}`)
  log(`请求前    : 可用 ${before.available} / 预留 ${before.reserved} / 体验版 ${before.subscription} / 活动 ${before.campaign}`)

  const t0 = Date.now()
  const res = await loader.fetch(loader.baseURL + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 24, messages: [{ role: "user", content: "回两个字：收到" }] }),
  })
  const text = await res.text()
  const ms = Date.now() - t0

  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {}

  const result = {
    model,
    httpStatus: res.status,
    ms,
    actualModel: parsed?.model ?? null,
    inputTokens: parsed?.usage?.input_tokens ?? null,
    outputTokens: parsed?.usage?.output_tokens ?? null,
    free: null,
    delta: null,
    note: "",
  }

  log(`HTTP      : ${res.status}  ${ms}ms`)
  if (parsed?.usage) {
    log(`实际模型  : ${parsed.model}`)
    log(`token     : in=${parsed.usage.input_tokens} out=${parsed.usage.output_tokens}`)
  } else {
    log(`响应      : ${text.slice(0, 200)}`)
  }

  // 结算要时间（先预留、后结算），多等几轮取稳定值
  let after = await wallet()
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const next = await wallet()
    if (next.available === after.available && next.reserved === after.reserved) {
      after = next
      break
    }
    after = next
  }

  log(`请求后    : 可用 ${after.available} / 预留 ${after.reserved} / 体验版 ${after.subscription} / 活动 ${after.campaign}`)

  const deltaAvailable = after.available - before.available
  const deltaReserved = after.reserved - before.reserved
  result.delta = deltaAvailable
  result.deltaReserved = deltaReserved

  // 判定：可用额度没降、预留也回落到 0 ⇒ 这次请求没花积分
  const spent = deltaAvailable < 0
  result.free = !spent
  result.note = spent
    ? `扣了 ${Math.abs(deltaAvailable)} 积分`
    : deltaReserved > 0
      ? "可用未降，但仍有预留未结算 —— 需要复查"
      : "可用额度未下降 ⇒ 不扣积分"

  log(`差额      : ${deltaAvailable}（预留 ${deltaReserved}）`)
  log(`判定      : ${result.note}`)

  if (asJson) console.log(JSON.stringify(result))
} finally {
  releaseLock()
}

process.exit(0)
