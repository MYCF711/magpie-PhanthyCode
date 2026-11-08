#!/usr/bin/env node
// scripts/verify-loader.mjs —— 用**插件生产 loader** 跑单链验证（管理员执行，会联网）
//
// 与 verify-protocol.mjs 的区别：那个是独立探针，会绕过插件本体；这个走真实路径
// （组件 → loader → 生产链 profile/注册/activities → /v1/messages），能证明「插件本身能不能用」。
//
// 用法：
//   PHANTHY_ALLOW_LOCAL_IMPORT=1 node scripts/verify-loader.mjs --auth-source local [--report verify-loader.json]
//   node scripts/verify-loader.mjs --auth-source oauth
//
// 硬边界：
//   · 推理**只发一次**，`max_tokens: 16`、`stream: false`、单条 user 消息；
//   · 默认模型取服务端目录的 `default_model`，不自己挑；
//   · 不打印 token / 私钥 / 完整响应体，只报状态码、实际模型、usage 与文本长度；
//   · 签到钩子按账号单飞、幂等（同一天只发一条）。

import { writeFileSync } from "node:fs"

import { PhanthyCodeAuthPlugin } from "../index.mjs"
import { readImportedAccess } from "../src/local-import.mjs"
import { get } from "../src/api.mjs"

export const MAX_TOKENS = 16

function parseArgs(argv) {
  const out = { authSource: "local", report: "", model: "", base: "" }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === "--auth-source") {
      out.authSource = String(argv[++i] ?? "local")
    } else if (key === "--report") {
      out.report = String(argv[++i] ?? "")
    } else if (key === "--model") {
      out.model = String(argv[++i] ?? "")
    } else if (key === "--base") {
      out.base = String(argv[++i] ?? "")
    } else if (key === "--help" || key === "-h") {
      out.help = true
    } else {
      out.unknown = key
    }
  }
  return out
}

function redact(value) {
  const text = String(value ?? "")
  if (!text) return "<empty>"
  return `len=${text.length}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log("node scripts/verify-loader.mjs [--auth-source local|oauth] [--model <id>] [--report <file>]\n\n走插件生产 loader：目录 → loader → 一次 max_tokens=16 推理。")
    return
  }
  if (args.unknown) {
    console.error(`✖ 未知参数：${args.unknown}`)
    process.exit(2)
  }
  // 0.2.14：本机导入不再要求 `PHANTHY_ALLOW_LOCAL_IMPORT=1`。
  // 那个闸门只会误伤 —— magpie 是独立进程，用户在 shell 里设的环境变量它看不到。

  const report = { authSource: args.authSource, steps: [], startedAt: new Date().toISOString() }

  // 登录态：本机导入只取 access token；不做 OAuth 交互（要 OAuth 请用 verify-protocol.mjs）
  let auth
  if (args.authSource === "local") {
    const imported = readImportedAccess()
    auth = { type: "api", key: imported.access, expires: imported.expires }
    report.login = { source: "local", access: redact(imported.access), remainingSeconds: imported.remainingSeconds }
  } else {
    console.error("✖ oauth 分支请用 scripts/verify-protocol.mjs 完成交互登录后再复用 token")
    process.exit(2)
  }

  const plugin = await PhanthyCodeAuthPlugin({}, {})
  const getAuth = async () => auth

  // ① 模型目录（插件钩子，走缓存）
  const models = await plugin.provider.models({}, { auth })
  const ids = Object.keys(models)
  const defaultModel = args.model || ids[0]
  report.steps.push({ step: "models", count: ids.length, defaultModel, sample: ids.slice(0, 5) })
  console.log(`[1/4] 模型目录：${ids.length} 条，默认 ${defaultModel}`)

  // ② loader：拿 baseURL / fetch（内部会跑生产链：profile → 注册 → activities → 落盘）
  const loaded = await plugin.auth.loader(getAuth, { id: "phanthy" })
  report.steps.push({ step: "loader", baseURL: loaded.baseURL, apiKey: redact(loaded.apiKey) })
  console.log(`[2/4] loader：baseURL=${loaded.baseURL}`)

  // ③ 额度（只读）
  const usage = await plugin.auth.usage(getAuth, { id: "phanthy" })
  report.steps.push({
    step: "usage",
    error: usage.error ?? "",
    plan: usage.plan ?? "",
    windows: (usage.windows ?? []).map((w) => ({ name: w.name, used: w.used, balance: w.balance })),
  })
  console.log(`[3/4] 额度：${usage.error ? `error=${usage.error}` : `${(usage.windows ?? []).length} 个窗口`}`)

  // ④ 一次最小推理（max_tokens=16，非流式）
  const body = {
    model: defaultModel,
    max_tokens: MAX_TOKENS,
    stream: false,
    messages: [{ role: "user", content: "ping" }],
  }
  const started = Date.now()
  const res = await loaded.fetch(`${loaded.baseURL}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const elapsedMs = Date.now() - started
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  report.steps.push({
    step: "inference",
    status: res.status,
    ok: res.ok,
    model: parsed?.model ?? defaultModel,
    stopReason: parsed?.stop_reason ?? "",
    usage: parsed?.usage ?? null,
    textLength: redact(parsed?.content?.[0]?.text ?? ""),
    elapsedMs,
    errorCode: String(parsed?.error?.type ?? parsed?.error?.code ?? ""),
    errorMessage: String(parsed?.error?.message ?? "").slice(0, 300),
  })
  console.log(`[4/4] 推理：HTTP ${res.status} · model=${parsed?.model ?? defaultModel} · ${elapsedMs}ms`)

  // ⑤ 签到：只读，不领取
  const checkin = await plugin.auth.checkin(getAuth, { id: "phanthy" })
  report.steps.push({ step: "checkin", outcome: checkin.outcome, message: checkin.message ?? "" })
  console.log(`[+] 签到：${checkin.outcome}（只读，未领取）`)

  report.finishedAt = new Date().toISOString()
  const json = JSON.stringify(report, null, 2)
  if (args.report) {
    writeFileSync(args.report, `${json}\n`, "utf8")
    console.log(`\n脱敏报告：${args.report}`)
  } else {
    console.log(`\n${json}`)
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("verify-loader.mjs")
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\n✖ 失败：${error?.message ?? error}`)
    process.exit(3)
  })
}
