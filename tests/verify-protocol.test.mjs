// tests/verify-protocol.test.mjs —— 单链验证脚本的执行级测试（离线；全部注入假 fetch）
//
// 算法定案后只有**一次**完整注册：
//   installationId = base64url(sha256(accountScope))，7 字段 body + 两条签名。
// 这里断言「实际发出去的 URL / body / 头」，以及失败分支不白烧请求。

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import {
  ACTIVITY_PATH,
  CATALOG_PATH,
  FORBIDDEN,
  LIMITS,
  buildActivities,
  needsLoopback,
  redact,
  runVerification,
} from "../scripts/verify-protocol.mjs"
import { PROFILE_PATH } from "../src/phanthy-api.mjs"
import { installationIdFromPublicKey } from "../src/installation-id.mjs"
import { deviceCanonical, generateEd25519KeyPair, importPublicKey, verifyCanonical } from "../src/proof.mjs"
import { REGISTER_PATH } from "../src/registration.mjs"

const TOKEN = "access-test-token"
const SCOPE = "8f14e45f-ceea-467a-9c1f-2b3d4e5f6a7b"
const NOW = () => 1_767_225_600_000
const NONCE = "NONCE_FIXED_000000000000"

function fakeFetch(responses = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    const key = Object.keys(responses).find((k) => String(url).includes(k))
    let spec = key ? responses[key] : { status: 200, body: {} }
    if (typeof spec === "function") spec = spec(url, init, calls.length)
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }
  return { calls, fetchImpl }
}

const OK = {
  [CATALOG_PATH]: { status: 200, body: { schema_version: 1, default_model: "phanthy-fast", models: [{ id: "phanthy-fast" }] } },
  [REGISTER_PATH]: { status: 200, body: { ok: true } },
  [ACTIVITY_PATH]: { status: 200, body: { desktop_inference_token: "inference-token-test", server_time: 1 } },
}

function base(opts = {}) {
  return { token: TOKEN, accountScope: SCOPE, register: 1, activities: true, now: NOW, nonce: NONCE, ...opts }
}

test("单次完整注册：7 字段 body、三把独立密钥、installationId 来自 identity 公钥", async () => {
  const pair = generateEd25519KeyPair()
  const devicePair = generateEd25519KeyPair()
  const inferencePair = generateEd25519KeyPair()
  const { calls, fetchImpl } = fakeFetch(OK)
  const report = await runVerification(
    base({ fetchImpl, publicKeyPair: pair, deviceKeyPair: devicePair, inferenceKeyPair: inferencePair }),
  )

  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    [CATALOG_PATH, REGISTER_PATH, ACTIVITY_PATH],
    "目录 → 一次注册 → activities",
  )
  assert.equal(report.counts.register, 1)

  const register = calls[1]
  const body = JSON.parse(register.init.body)
  assert.deepEqual(Object.keys(body), [
    "public_key",
    "edition",
    "platform",
    "version",
    "device_public_key",
    "device_signature",
    "inference_public_key",
  ])
  assert.equal(body.public_key, pair.publicKeyB64Url, "用的是插件自己新生成的 identity 密钥")
  assert.equal(body.device_public_key, devicePair.publicKeyB64Url, "device 是独立那把")
  assert.equal(body.inference_public_key, inferencePair.publicKeyB64Url, "inference 是 sidecar 会话那把")
  assert.equal(new Set([body.public_key, body.device_public_key, body.inference_public_key]).size, 3, "三把互不相同")
  assert.equal(body.version, "2.48.0", "官方客户端版本号")

  const expectedId = installationIdFromPublicKey(pair.publicKeyB64Url)
  assert.equal(expectedId.length, 46, "di_ + 43 字符 base64url")
  const headers = register.init.headers
  assert.equal(headers["x-desktop-installation-id"], expectedId)
  assert.equal(headers["idempotency-key"], `register:${expectedId}`)
  assert.ok(headers["x-desktop-timestamp"])
  assert.ok(headers["x-desktop-nonce"])
  assert.ok(headers["x-desktop-signature"])
  assert.equal(headers.authorization, `Bearer ${TOKEN}`)

  // device canonical 第 2 段就是 accountScope，第 4 段是 identity 公钥；
  // device_signature 必须能用 **device** 公钥验过（用 identity 公钥验必须失败）
  const canonical = deviceCanonical({
    accountScope: SCOPE,
    installationId: expectedId,
    publicKey: body.public_key,
    sessionKeyPublicKey: body.inference_public_key,
    timestamp: headers["x-desktop-timestamp"],
    nonce: headers["x-desktop-nonce"],
  })
  assert.equal(verifyCanonical(importPublicKey(devicePair.publicKeyB64Url), canonical, body.device_signature), true)
  assert.equal(verifyCanonical(importPublicKey(pair.publicKeyB64Url), canonical, body.device_signature), false)

  const activity = report.steps.find((s) => s.step === "activities")
  assert.equal(activity.installationId, expectedId)
  assert.equal(activity.sentIdempotencyKey, false, "activities 不发幂等键头")
  assert.equal(activity.hasInferenceToken, true)
})

test("scope 变化不影响 installationId（id 只由公钥决定）", () => {
  const pair = generateEd25519KeyPair()
  const a = installationIdFromPublicKey(pair.publicKeyB64Url)
  const b = installationIdFromPublicKey(generateEd25519KeyPair().publicKeyB64Url)
  assert.notEqual(a, b)
  assert.match(a, /^di_[A-Za-z0-9_-]{43}$/)
})

test("缺 accountScope → 一条注册都不发，activities 也不发", async () => {
  const pair = generateEd25519KeyPair()
  const { calls, fetchImpl } = fakeFetch(OK)
  const report = await runVerification(base({ fetchImpl, publicKeyPair: pair, accountScope: "" }))

  assert.equal(calls.filter((c) => c.url.includes(REGISTER_PATH)).length, 0)
  assert.equal(calls.filter((c) => c.url.includes(ACTIVITY_PATH)).length, 0)
  assert.equal(report.counts.register, 0)
  assert.equal(report.steps.find((s) => s.step === "register").skipped, "account_scope_pending")
})

test("注册失败 → 不调 activities，保留脱敏的 code/message", async () => {
  const pair = generateEd25519KeyPair()
  const { calls, fetchImpl } = fakeFetch({
    [CATALOG_PATH]: OK[CATALOG_PATH],
    [REGISTER_PATH]: { status: 409, body: { error: { code: "desktop_installation_conflict", message: "mismatch" } } },
    [ACTIVITY_PATH]: { status: 200, body: { desktop_inference_token: "should-not-happen" } },
  })
  const report = await runVerification(base({ fetchImpl, publicKeyPair: pair }))

  assert.equal(calls.filter((c) => c.url.includes(ACTIVITY_PATH)).length, 0)
  const register = report.steps.find((s) => s.step === "register")
  assert.equal(register.status, 409)
  assert.equal(register.errorCode, "desktop_installation_conflict")
  assert.equal(register.errorMessage, "mismatch")
  assert.equal(report.steps.find((s) => s.step === "activities").skipped, "registration_failed")
})

test("目录非 2xx → 注册前停止（不白烧注册）", async () => {
  const pair = generateEd25519KeyPair()
  const { calls, fetchImpl } = fakeFetch({
    [CATALOG_PATH]: { status: 401, body: { error: { code: "session_expired" } } },
    [REGISTER_PATH]: { status: 200, body: {} },
  })
  const report = await runVerification(base({ fetchImpl, publicKeyPair: pair }))
  assert.equal(calls.length, 1)
  assert.equal(report.counts.register, 0)
  assert.equal(report.steps.find((s) => s.step === "stop").after, "models")
})

test("--profile：先取 account.uuid（device canonical 第 2 段），id 仍由公钥派生", async () => {
  const pair = generateEd25519KeyPair()
  const { calls, fetchImpl } = fakeFetch({
    ...OK,
    [PROFILE_PATH]: { status: 200, body: { account: { uuid: SCOPE } } },
  })
  const report = await runVerification(base({ fetchImpl, publicKeyPair: pair, accountScope: "", profile: true }))

  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    [PROFILE_PATH, CATALOG_PATH, REGISTER_PATH, ACTIVITY_PATH],
  )
  assert.equal(report.counts.profile, 1)
  assert.equal(report.steps.find((s) => s.step === "profile").accountScopeMasked, "8f14e45f…")
  assert.equal(calls[2].init.headers["x-desktop-installation-id"], installationIdFromPublicKey(pair.publicKeyB64Url))
})

test("profile 缺 account.uuid → 立即停止，一条注册都不发", async () => {
  const pair = generateEd25519KeyPair()
  const { calls, fetchImpl } = fakeFetch({
    [PROFILE_PATH]: { status: 200, body: { account: { name: "no-uuid" } } },
    [REGISTER_PATH]: { status: 200, body: {} },
  })
  const report = await runVerification(base({ fetchImpl, publicKeyPair: pair, accountScope: "", profile: true }))
  assert.equal(calls.length, 1)
  assert.equal(report.counts.register, 0)
  const step = report.steps.find((s) => s.step === "profile")
  assert.equal(step.stopped, "internal_error")
  assert.equal(step.reason, "account_scope_missing")
})

test("没有任何调用会碰推理端点", async () => {
  const pair = generateEd25519KeyPair()
  const { calls, fetchImpl } = fakeFetch(OK)
  await runVerification(base({ fetchImpl, publicKeyPair: pair }))
  for (const call of calls) {
    for (const path of FORBIDDEN) assert.equal(call.url.includes(path), false, `碰到 ${path}`)
  }
})

test("计数器上限与 local 不启动 loopback", () => {
  assert.deepEqual(LIMITS, { oauth: 1, profile: 1, models: 1, register: 2, activities: 1 })
  assert.equal(needsLoopback("local"), false)
  assert.equal(needsLoopback("oauth"), true)
})

test("静态边界：全脚本只有一个 fetch 调用点，且在拒绝名单检查之后", () => {
  const source = readFileSync(new URL("../scripts/verify-protocol.mjs", import.meta.url), "utf8")
  assert.equal(source.split("\n").filter((l) => l.includes("await fetchImpl(")).length, 1)
  const sendBody = source.slice(source.indexOf("export async function send("), source.indexOf("export function buildProbeA"))
  assert.match(sendBody, /assertNotForbidden\(url\)/)
  assert.ok(sendBody.indexOf("assertNotForbidden(url)") < sendBody.indexOf("await fetchImpl("))
  for (const path of FORBIDDEN) {
    assert.equal(source.split("\n").filter((l) => l.includes(`"${path}"`)).length, 1, `${path} 只应出现在 FORBIDDEN`)
  }
})

test("脱敏函数不返回原值", () => {
  const out = redact("secret-token-value")
  assert.equal(out.includes("secret-token-value"), false)
  assert.match(out, /^len=18 sha8=[0-9a-f]{8}$/)
})
