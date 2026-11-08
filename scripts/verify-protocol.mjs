#!/usr/bin/env node
// scripts/verify-protocol.mjs —— 最小联网协议验证（探针 A/B）+ 可注入的离线外壳
//
// 目的：只用**一次 OAuth + 一次模型目录 + 最多两次设备注册 + 一次 activities/summary**
// 把剩余字段钉死，**不调用任何推理接口**、不消耗推理 credits。
//
// 两次注册不是「同策略重试」，各自定死一件事：
//   探针 A（新 I1，四字段 body）：不给 device_public_key / device_signature /
//     inference_public_key，让服务端用 4xx + code 告诉我们必填集；
//   探针 B（新 I2，**三把独立密钥**）：public_key=device 公钥以外的 identity、
//     device_public_key=device、inference_public_key=inference；
//     device_signature 用 device 私钥签、v1 头用 identity 私钥签（2026-11-09 真机实测）。
//
// 为什么要新 I2：`idempotency-key` 是 `register:<installationId>`，而 id 只由 identity
// 公钥决定，复用同一把公钥会被服务端去重，第二次等于白花 — 已修。
//
// activities/summary：body 只有 `{inference_public_key}`（inference 那把），走同一套
// v1 签名（identity 私钥），但**没有幂等键** —— canonical 第 7 段是空串，
// 请求头也不发 `idempotency-key`。
//
// 用法（在插件仓库根目录，由管理员执行）：
//   node scripts/verify-protocol.mjs [--account-scope <作用域>] [--register 1|2] \
//        [--activities] [--base https://code.phanthy.com] [--report <文件名>]
//
// 安全边界（写死在代码里）：
//   · 计数器封顶：oauth 1 / models 1 / register 2 / activities 1，超了直接退出；
//   · 出现 `/v1/messages`、`/v1/responses`、`/v1/chat/completions` 就拒绝；
//   · 输出全部走 `redact()`：token / 私钥只出现在内存，报告里只有长度与错误码；
//   · 不读桌面端 settings.json，不启动 sidecar，每次运行都是全新设备身份。

import { createHash, randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { OFFICIAL_UA } from "../src/http.mjs"
import { generatePkce, randomState, startLoopback } from "../src/oauth-pkce.mjs"
import {
  CALLBACK_PATH,
  DEFAULT_EXPIRES_IN,
  TOKEN_PATH,
  authorizationCodeForm,
  buildAuthorizeUrl,
  parseTokenResponse,
} from "../src/oauth.mjs"
import { parseCatalog } from "../src/catalog.mjs"
import { generateEd25519KeyPair, signCanonical, timestampNow, v1Canonical } from "../src/proof.mjs"
import { REGISTER_PATH, accountScopeFromProfile, buildRegistrationRequest, idempotencyKeyFor } from "../src/registration.mjs"
import { IDENTITY_POLICY } from "../src/production-auth.mjs"
import { PROFILE_PATH } from "../src/phanthy-api.mjs"
import { detectLocalLogin, readImportedAccess, summarizeDetection } from "../src/local-import.mjs"
import { OFFICIAL_RULE, installationIdFromPublicKey } from "../src/installation-id.mjs"

export const LIMITS = { oauth: 1, profile: 1, models: 1, register: 2, activities: 1 }

export const FORBIDDEN = ["/v1/messages", "/v1/responses", "/v1/chat/completions"]

export const CATALOG_PATH = "/api/phanthy_code/models"
export const ACTIVITY_PATH = "/api/oauth/activities/summary"
export const EDITION = "phanthy_work"

/** 探针 A 的 body：只有四个字段，用来逼出服务端的必填集 */
export function probeABody({ publicKey, platform, version }) {
  return { public_key: publicKey, edition: EDITION, platform, version }
}

/** 脱敏：长度 + 前 8 位 sha256，绝不输出原值 */
export function redact(value) {
  const text = String(value ?? "")
  if (!text) return "<empty>"
  return `len=${text.length} sha8=${createHash("sha256").update(text).digest("hex").slice(0, 8)}`
}

function assertNotForbidden(url) {
  for (const path of FORBIDDEN) {
    if (String(url).includes(path)) {
      throw new Error(`拒绝：脚本不允许访问推理接口 ${path}`)
    }
  }
}

/**
 * 出站请求的唯一入口：所有请求都过这里（离线测试也断言这一层）。
 * 返回 `{ status, ok, body }`，非 JSON 也只会在 `body._nonJson` 里留片段。
 */
export async function send({ url, method = "GET", token, json, form, headers: extra = {}, fetchImpl = globalThis.fetch }) {
  assertNotForbidden(url)
  const headers = { "user-agent": OFFICIAL_UA, accept: "application/json", ...extra }
  if (token) headers.authorization = `Bearer ${token}`
  let body
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded"
    body = form.toString()
  } else if (json !== undefined) {
    headers["content-type"] = "application/json"
    body = typeof json === "string" ? json : JSON.stringify(json)
  }
  const res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { _nonJson: text.slice(0, 200) }
  }
  return { status: res.status, ok: res.ok, body: parsed }
}

/**
 * 探针 A 的完整请求：四字段 body + 完整 `x-desktop-*` 头（v1 签名覆盖这个 body）。
 * 不秀签名，只在测试里验。
 */
export function buildProbeA({ token, installationId, publicKey, platform, version, now = Date.now, nonce }) {
  const body = probeABody({ publicKey, platform, version })
  const bodyString = JSON.stringify(body)
  const timestamp = String(now())
  const nonceValue = nonce ?? randomUUID()
  const canonical = v1Canonical({
    method: "POST",
    upstreamPath: REGISTER_PATH,
    timestamp,
    nonce: nonceValue,
    body: bodyString,
    idempotencyKey: idempotencyKeyFor(installationId),
  })
  return {
    body,
    bodyString,
    canonical,
    timestamp,
    nonce: nonceValue,
    installationId,
    idempotencyKey: idempotencyKeyFor(installationId),
    headers: {
      "x-desktop-installation-id": installationId,
      "x-desktop-timestamp": timestamp,
      "x-desktop-nonce": nonceValue,
      "idempotency-key": idempotencyKeyFor(installationId),
    },
    sign(privateKey) {
      const signature = signCanonical(privateKey, canonical)
      return { ...this, headers: { ...this.headers, "x-desktop-signature": signature }, signature }
    },
    token,
  }
}

/**
 * 探针 B 的完整请求：**三把独立密钥**（2026-11-09 真机实测的生产契约）。
 * device_signature 用 device 私钥、v1 头用 identity 私钥，`inference_public_key` 是
 * inference（sidecar 会话）公钥。复用 `src/registration.mjs` 的构造器与生产 policy
 * （字段顺序与两条签名同源），只在外面补 token/头。
 */
export function buildProbeB({ token, record, accountScope, platform, version, now = Date.now, nonce }) {
  const built = buildRegistrationRequest({
    record,
    policy: IDENTITY_POLICY,
    sessionKeyPublicKey: record.inferencePublicKey,
    accountScope,
    accessToken: token,
    now,
    nonce,
  })
  // ⚠ 不再二次修改 body：签名覆盖的是 built.bodyString，改一个字段就对不上
  return { ...built, token }
}

/**
 * activities/summary：body 只有 `{inference_public_key}`（**inference** 那把），
 * v1 canonical 第 7 段空串，请求头**不发** `idempotency-key`。
 */
export function buildActivities({ token, record, now = Date.now, nonce }) {
  const body = { inference_public_key: record.inferencePublicKey }
  const bodyString = JSON.stringify(body)
  const timestamp = String(now())
  const nonceValue = nonce ?? randomUUID()
  const canonical = v1Canonical({
    method: "POST",
    upstreamPath: ACTIVITY_PATH,
    timestamp,
    nonce: nonceValue,
    body: bodyString,
    idempotencyKey: "",
  })
  return {
    body,
    bodyString,
    canonical,
    timestamp,
    nonce: nonceValue,
    headers: {
      "x-desktop-installation-id": record.installationId,
      "x-desktop-timestamp": timestamp,
      "x-desktop-nonce": nonceValue,
    },
    sign(privateKey) {
      const signature = signCanonical(privateKey, canonical)
      return { ...this, headers: { ...this.headers, "x-desktop-signature": signature }, signature }
    },
    token,
  }
}

/**
 * 跑完整验证（可注入 fetch / 固定时间 / 固定 nonce），返回脱敏报告。
 *
 * 顺序：models(A 之前先确认 OAuth 能否用于数据面) → 探针 A → 探针 B（需要 accountScope）
 * → activities（只在注册成功时才发）。任何一步失败都**不**自动重试。
 */
export async function runVerification({
  token,
  base = "https://code.phanthy.com",
  fetchImpl = globalThis.fetch,
  accountScope = "",
  register = 2,
  activities = true,
  profile = false,
  now = Date.now,
  nonce,
  log = () => {},
  publicKeyPair = generateEd25519KeyPair(),
  deviceKeyPair = generateEd25519KeyPair(),
  inferenceKeyPair = generateEd25519KeyPair(),
  platform = platformName(),
  version = pluginVersion(),
} = {}) {
  const normalizedBase = String(base).replace(/\/+$/, "")
  const used = { oauth: 0, profile: 0, models: 0, register: 0, activities: 0 }
  const report = { base: normalizedBase, steps: [], counts: used, startedAt: new Date().toISOString() }

  const take = (kind) => {
    used[kind] += 1
    if (used[kind] > LIMITS[kind]) throw new Error(`越界：${kind} 已调用 ${used[kind]} 次，上限 ${LIMITS[kind]}`)
  }

  // ── accountScope：只能来自账号档案 account.uuid（缺失即停止，排在注册之前）
  let scope = String(accountScope ?? "").trim()
  if (!scope && profile) {
    take("profile")
    const res = await send({ url: `${normalizedBase}${PROFILE_PATH}`, token, fetchImpl })
    try {
      if (!res.ok) {
        throw Object.assign(new Error(`账号档案 HTTP ${res.status}：${String(res.body?.error?.message ?? res.body?.message ?? "")}`), {
          code: "internal_error",
          reason: String(res.body?.error?.code ?? "profile_failed"),
        })
      }
      scope = accountScopeFromProfile(res.body)
    } catch (error) {
      // 官方顺序 profile → identity → register：取不到就一条注册都不发，避免白烧次数
      report.steps.push({
        step: "profile",
        status: res.status,
        stopped: error.code ?? "profile_failed",
        reason: error.reason ?? "",
        message: String(error.message ?? error),
        bodyKeys: keysOf(res.body),
      })
      report.counts = { ...used }
      report.finishedAt = new Date().toISOString()
      log(`✖ accountScope 取不到（${error.reason || error.code || "profile_failed"}），已停止：不发注册、不发 activities`)
      return report
    }
    report.steps.push({ step: "profile", status: res.status, ok: true, accountScopeMasked: maskScope(scope) })
    log(`[1/5] 账号档案：HTTP ${res.status} · accountScope=${maskScope(scope)}`)
  } else {
    report.steps.push({
      step: "profile",
      skipped: scope ? "account_scope_given" : "not_requested",
      note: scope ? "用命令行给的 accountScope，不额外请求档案" : "未加 --profile：注册将跳过",
    })
    log(`[1/5] 账号档案：跳过（${scope ? "已给作用域" : "未开启"}）`)
  }

  // ── 模型目录（一次）──────────────────────────────────────────────
  take("models")
  const modelsRes = await send({ url: `${normalizedBase}${CATALOG_PATH}`, token, fetchImpl })
  let catalog = null
  if (modelsRes.ok) {
    try {
      catalog = parseCatalog(modelsRes.body)
    } catch (error) {
      log(`  ! 目录形状不符：${error.message}`)
    }
  }
  report.steps.push({
    step: "models",
    status: modelsRes.status,
    schemaVersion: modelsRes.body?.schema_version,
    count: Array.isArray(modelsRes.body?.models) ? modelsRes.body.models.length : null,
    parsed: catalog ? { default: catalog.defaultModel, ids: catalog.models.slice(0, 5).map((m) => m.id) } : null,
    errorCode: String(modelsRes.body?.error?.code ?? ""),
    errorMessage: modelsRes.ok ? "" : String(modelsRes.body?.error?.message ?? modelsRes.body?.message ?? ""),
  })
  log(`[2/5] 模型目录：HTTP ${modelsRes.status}` + (catalog ? ` · ${catalog.models.length} 条` : ""))
  if (!modelsRes.ok) {
    // 401/403 说明凭据根本不能用于数据面：此时再打注册只是白烧授权次数
    report.steps.push({
      step: "stop",
      after: "models",
      status: modelsRes.status,
      note: "目录非 2xx：不进入设备注册",
    })
    report.counts = { ...used }
    report.finishedAt = new Date().toISOString()
    log(`✖ 目录 HTTP ${modelsRes.status}：停止，不发注册`)
    return report
  }

  // ── 设备注册：单次完整请求（官方算法已确认，A/B 双探针作废）──────────
  // installationId = di_ + base64url(sha256(SPKI_DER[12:]))：只由 identity 公钥决定，
  // 同一把公钥必然同一个 ID，再拆两个探针只会撞 `idempotency-key`，所以这里只发一次完整 body。
  let regEntry = { step: "register", status: 0, ok: false }
  if (register < 1) {
    report.steps.push({ step: "register", skipped: "disabled_by_flag" })
    log("[3/4] 设备注册：跳过（--register 0）")
  } else if (!scope) {
    report.steps.push({
      step: "register",
      skipped: "account_scope_pending",
      note: "accountScope 只能来自 GET /api/oauth/profile 的 account.uuid（device canonical 第 2 段）",
    })
    log("[3/4] 设备注册：跳过（缺 accountScope，不猜）")
  } else {
    const installationId = installationIdFromPublicKey(publicKeyPair.publicKeyB64Url)
    const record = {
      schemaVersion: 1,
      installationId,
      publicKey: publicKeyPair.publicKeyB64Url,
      privateKey: publicKeyPair.privateKeyB64Url,
      devicePublicKey: deviceKeyPair.publicKeyB64Url,
      devicePrivateKey: deviceKeyPair.privateKeyB64Url,
      inferencePublicKey: inferenceKeyPair.publicKeyB64Url,
      inferencePrivateKey: inferenceKeyPair.privateKeyB64Url,
      accountScope: scope,
    }
    const built = buildProbeB({ token, record, accountScope: scope, platform, version, now, nonce })

    take("register")
    const res = await send({
      url: `${normalizedBase}${REGISTER_PATH}`,
      method: "POST",
      token,
      json: built.bodyString,
      headers: built.headers,
      fetchImpl,
    })
    regEntry = {
      step: "register",
      installationId,
      installationIdRule: OFFICIAL_RULE,
      status: res.status,
      ok: res.ok,
      bodyKeys: Object.keys(built.body),
      // 三把密钥必须互不相同（真机实测）；等于是错的
      threeKeysDistinct: new Set([
        built.body.public_key,
        built.body.device_public_key,
        built.body.inference_public_key,
      ]).size === 3,
      signers: built.signers,
      headerKeys: Object.keys(built.headers).sort(),
      errorCode: String(res.body?.error?.code ?? res.body?.code ?? ""),
      errorMessage: String(res.body?.error?.message ?? res.body?.message ?? "").slice(0, 300),
    }
    report.steps.push(regEntry)
    log(`[3/4] 设备注册：HTTP ${res.status}` + (regEntry.errorCode ? ` · code=${regEntry.errorCode}` : ""))
  }
  // ── activities/summary：只有注册成功才发 ──────────────────────────
  const registered = regEntry.ok
  const successfulInstallationId = regEntry.ok ? regEntry.installationId : ""
  if (activities && registered && successfulInstallationId) {
    take("activities")
    const req = buildActivities({
      token,
      record: {
        installationId: successfulInstallationId,
        publicKey: publicKeyPair.publicKeyB64Url,
        inferencePublicKey: inferenceKeyPair.publicKeyB64Url,
      },
      now,
      nonce,
    }).sign(publicKeyPair.privateKey)
    const res = await send({
      url: `${normalizedBase}${ACTIVITY_PATH}`,
      method: "POST",
      token,
      json: req.bodyString,
      headers: req.headers,
      fetchImpl,
    })
    const inferenceToken = String(res.body?.desktop_inference_token ?? "")
    report.steps.push({
      step: "activities",
      status: res.status,
      ok: res.ok,
      hasInferenceToken: Boolean(inferenceToken),
      inferenceToken: redact(inferenceToken),
      serverTime: res.body?.server_time ?? "",
      canonicalSegments: req.canonical.split("\n").length,
      lastSegment: req.canonical.split("\n").at(-1),
      sentIdempotencyKey: "idempotency-key" in req.headers,
      errorCode: String(res.body?.error?.code ?? ""),
      errorMessage: String(res.body?.error?.message ?? "").slice(0, 300),
      installationId: successfulInstallationId,
    })
    log(`[4/4] activities/summary：HTTP ${res.status} · token ${inferenceToken ? "有" : "无"}`)
  } else {
    report.steps.push({
      step: "activities",
      skipped: registered ? "disabled_by_flag" : "registration_failed",
      note: registered ? "已关闭 activities" : "注册未成功，按约定不继续调用 activities",
    })
    log(`[4/4] activities/summary：跳过（${registered ? "未开启" : "注册未成功"}）`)
  }

  report.counts = { ...used }
  report.finishedAt = new Date().toISOString()
  return report
}

/** accountScope 是账号标识：报告里只留前 8 位，够核对同一性、看不出全值 */
/**
 * 这一条登录入口要不要起 loopback 监听。
 * 本机导入是**纯读文件**，一个 socket 都不该开 —— 之前就是这里漏了，进程跑完不退。
 */
export function needsLoopback(authSource) {
  return authSource !== "local"
}

/** accountScope 是账号标识：报告里只留前 8 位，够核对同一性、看不出全值 */
export function maskScope(scope) {
  const text = String(scope ?? "")
  if (!text) return "<empty>"
  return `${text.slice(0, 8)}…`
}

function keysOf(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 1) return []
  return Object.keys(value)
}

export function platformName(platform = process.platform) {
  if (platform === "win32") return "windows"
  if (platform === "darwin") return "macos"
  return "linux"
}

export function pluginVersion() {
  try {
    return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.1.0")
  } catch {
    return "0.1.0"
  }
}

// ── CLI 外壳（只在直接执行时跑；被 import 时不联网）─────────────────────

function parseArgs(argv) {
  const out = { base: "https://code.phanthy.com", register: 1, activities: true, profile: false, authSource: "oauth", report: "", accountScope: "" }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const next = argv[i + 1]
    switch (key) {
      case "--base":
        out.base = String(next ?? "")
        i += 1
        break
      case "--account-scope":
        out.accountScope = String(next ?? "")
        i += 1
        break
      case "--register":
        out.register = Math.max(0, Math.min(Number(next) || 0, 1))
        i += 1
        break
      case "--profile":
        out.profile = true
        break

      case "--auth-source": {
        const value = String(next ?? "").trim()
        if (value !== "oauth" && value !== "local") {
          out.unknown = `--auth-source 只接受 oauth 或 local（收到 ${value || "空"}）`
          break
        }
        out.authSource = value
        i += 1
        break
      }
      case "--import":
        // 旧写法，等价于 --auth-source local
        out.authSource = "local"
        break
      case "--no-activities":
        out.activities = false
        break
      case "--report":
        out.report = String(next ?? "")
        i += 1
        break
      case "--help":
      case "-h":
        out.help = true
        break
      default:
        out.unknown = key
    }
  }
  return out
}

function printUsage() {
  console.log(
    [
      "node scripts/verify-protocol.mjs [选项]",
      "",
      "  --auth-source <oauth|local>  登录入口：浏览器 OAuth（默认）或本机导入",
      "  --profile            先 GET /api/oauth/profile，从 account.uuid 取 accountScope（一次只读）",

      "  --account-scope <s>  已知作用域时直接给；两者都没有则跳过探针 B",
      "  --register <0|1>     设备注册次数（默认 1；算法已确认，单次完整注册）",
      "  --no-activities      不调 activities/summary（默认在注册成功后调一次）",
      "  --base <url>         云端基址（默认 https://code.phanthy.com）",
      "  --report <file>      把脱敏报告写到文件（默认打印）",
      "",
      "设备注册：installationId = di_ + base64url(sha256(SPKI_DER[12:]))，一次完整 body（7 字段 + 两条签名）",
      "不调用任何推理接口；token 只在内存，不写盘、不打印。",
    ].join("\n"),
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }
  if (args.unknown) {
    console.error(`✖ 未知参数：${args.unknown}`)
    process.exit(2)
  }

  console.log(`\n=== Phanthy 最小协议验证 ===\n基址：${args.base}\n不调用任何推理接口。\n`)

  let token
  if (!needsLoopback(args.authSource)) {
    // 本机导入：只取云端 access token，不复制 refresh_token / 推理令牌 / 设备私钥
    const detection = detectLocalLogin()
    if (!detection.importable) {
      console.error(`✖ 本机没有可导入的云端登录：\n${summarizeDetection(detection).lines.map((l) => `  ${l}`).join("\n")}`)
      process.exit(3)
    }
    token = readImportedAccess().access
    console.log(`[0/5] 本机导入：使用本机云端 access token（${redact(token)}，未导入 refresh_token/设备私钥）\n`)
  } else {
    const state = randomState()
    const pkce = generatePkce()
    const listener = await startLoopback({ state, path: CALLBACK_PATH, timeoutMs: 5 * 60_000 })
    const authorizeUrl = buildAuthorizeUrl({
      base: args.base,
      redirectUri: listener.redirectUri,
      state,
      codeChallenge: pkce.challenge,
    })

    console.log("[0/5] 请用浏览器打开下面的地址完成官方登录（5 分钟内）：\n")
    console.log(`  ${authorizeUrl}\n`)
    console.log(`  回调地址：${listener.redirectUri}`)
    console.log("  授权码只在本进程内存里换票，不会打印。\n")

    try {
      const redirected = await listener.wait()
      if (redirected.state && redirected.state !== state) throw new Error("state 校验失败")
      const res = await send({
        url: `${String(args.base).replace(/\/+$/, "")}${TOKEN_PATH}`,
        method: "POST",
        form: authorizationCodeForm({
          code: redirected.code,
          state,
          codeVerifier: pkce.verifier,
          redirectUri: listener.redirectUri,
        }),
      })
      if (!res.ok) throw new Error(`换票失败：HTTP ${res.status} ${String(res.body?.error ?? res.body?.message ?? "")}`)
      const parsed = parseTokenResponse(res.body)
      token = parsed.access
      console.log(`  ✓ 换票成功（access ${redact(parsed.access)}，refresh_token ${parsed.refresh ? "有" : "无"}，expires_in ${parsed.expiresIn || DEFAULT_EXPIRES_IN}）\n`)
    } finally {
      try {
        listener.close()
      } catch {}
    }
  }
  const report = await runVerification({
    token,
    base: args.base,
    accountScope: args.accountScope,
    profile: args.profile,
    register: args.register,
    activities: args.activities,

    log: (line) => console.log(line),
  })
  report.auth = { source: args.authSource, access: redact(token), refresh: args.authSource === "local" ? "absent" : "present" }

  const json = JSON.stringify(report, null, 2)
  if (args.report) {
    writeFileSync(args.report, `${json}\n`, "utf8")
    console.log(`\n脱敏报告已写到 ${args.report}`)
  } else {
    console.log("\n脱敏报告（可直接贴回群里）：\n")
    console.log(json)
  }
  console.log("\n✓ 验证结束。没有调用任何推理接口，也没有落盘 token 或私钥。\n")
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\n✖ 失败：${error?.message ?? error}`)
    process.exit(3)
  })
}