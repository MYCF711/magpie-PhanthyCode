// tests/production-auth.test.mjs —— 生产链：profile → 派生ID → 单次注册 → activities → 落盘（离线）
//
// 这里测的是**插件本体**用的那条链（loader 现在走它），不是独立探针脚本。

import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "pw-prod-"))
process.env.USERPROFILE = home
process.env.HOME = home

const {
  REGISTRATION_COOLDOWN_MS,
  ensureInstallationReady,
  isInstallationReady,
  isRegistrationBlocked,
  maskInstallationId,
  _resetInflight,
} = await import("../src/production-auth.mjs")
const { readInstallation, clearInstallation } = await import("../src/device-key.mjs")
const { PROFILE_PATH } = await import("../src/phanthy-api.mjs")
const { ACTIVITY_SUMMARY_PATH } = await import("../src/phanthy-api.mjs")
import { fakeInferenceToken } from "./helpers/inference-token.mjs"
const { REGISTER_PATH } = await import("../src/registration.mjs")
const { installationIdFromPublicKey } = await import("../src/installation-id.mjs")

after(() => rmSync(home, { recursive: true, force: true }))

const SCOPE = "8f14e45f-ceea-467a-9c1f-2b3d4e5f6a7b"
const AUTH = { type: "oauth", access: "access-test" }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function recorder(routes = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    const key = Object.keys(routes).find((k) => String(url).includes(k))
    const spec = key ? routes[key] : { status: 200, body: {} }
    const out = typeof spec === "function" ? spec(url, init) : spec
    return json(out.body ?? {}, out.status ?? 200)
  }
  return { calls, fetchImpl }
}

const ROUTES = {
  [PROFILE_PATH]: { status: 200, body: { account: { uuid: SCOPE } } },
  [REGISTER_PATH]: { status: 200, body: { ok: true } },
  // ⚠ 令牌必须是**结构合法**的 JWT：isInstallationReady() 现在会校验 exp 与
  //   inference_public_key 是否与记录一致。裸字符串会被判成「需要换票」，
  //   于是第二段测试（零请求）会变成又跑一遍注册链。
  [ACTIVITY_SUMMARY_PATH]: (_url, init) => {
    const sent = JSON.parse(init?.body ?? "{}")
    return {
      status: 200,
      body: {
        desktop_inference_token: fakeInferenceToken({ inferencePublicKey: sent.inference_public_key ?? "" }),
        server_time: 1,
      },
    }
  },
}

beforeEach(() => {
  // 生产链默认零注册；这些用例验证的是「开关打开后」的链，所以显式开
  process.env.PHANTHY_ALLOW_DEVICE_REGISTER = "1"
  _resetInflight()
})

test("首次：profile → 注册 → activities 各一次，并把令牌落盘", async () => {
  clearInstallation("acct-first")
  const { calls, fetchImpl } = recorder(ROUTES)
  const record = await ensureInstallationReady({ account: "acct-first", auth: AUTH, fetchImpl, now: () => 1_700_000_000_000 })

  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    [PROFILE_PATH, REGISTER_PATH, ACTIVITY_SUMMARY_PATH],
    "顺序必须是 profile → register → activities",
  )
  assert.equal(record.accountScope, SCOPE)
  assert.equal(record.installationId, installationIdFromPublicKey(record.publicKey), "ID 只由 identity 公钥派生")
  assert.match(record.installationId, /^di_[A-Za-z0-9_-]{43}$/, "官方格式：di_ + 43 字符 base64url")
  assert.ok(record.registeredAt > 0, "注册时间必须落盘")
  assert.match(record.inferenceToken, /^[\w-]+\.[\w-]+\.[\w-]+$/, "令牌必须是三段式 JWT 并落盘")

  // 三把密钥互不相同，且都落盘（真机实测：device / inference 各是独立的一把）
  const keySet = new Set([record.publicKey, record.devicePublicKey, record.inferencePublicKey])
  assert.equal(keySet.size, 3, "identity / device / inference 必须互不相同")
  assert.ok(record.devicePrivateKey && record.inferencePrivateKey, "两把额外私钥必须落盘")

  const onDisk = readInstallation("acct-first")
  assert.match(onDisk.inferenceToken, /^[\w-]+\.[\w-]+\.[\w-]+$/)
  assert.equal(onDisk.installationId, record.installationId)
  assert.equal(onDisk.devicePublicKey, record.devicePublicKey)
  assert.equal(onDisk.inferencePublicKey, record.inferencePublicKey)
  assert.equal(isInstallationReady(onDisk), true)
})

test("第二次：已就绪 → 零请求（有效缓存不重复注册）", async () => {
  clearInstallation("acct-second")
  const first = recorder(ROUTES)
  await ensureInstallationReady({ account: "acct-second", auth: AUTH, fetchImpl: first.fetchImpl })

  const second = recorder(ROUTES)
  _resetInflight()
  const record = await ensureInstallationReady({ account: "acct-second", auth: AUTH, fetchImpl: second.fetchImpl })
  assert.equal(second.calls.length, 0, "就绪后不能再发任何请求")
  assert.match(record.inferenceToken, /^[\w-]+\.[\w-]+\.[\w-]+$/)
})

test("并发：同账号多个调用只跑一条链（只打一次 profile）", async () => {
  clearInstallation("acct-concurrent")
  _resetInflight()
  const { calls, fetchImpl } = recorder(ROUTES)
  const [a, b, c] = await Promise.all([
    ensureInstallationReady({ account: "acct-concurrent", auth: AUTH, fetchImpl }),
    ensureInstallationReady({ account: "acct-concurrent", auth: AUTH, fetchImpl }),
    ensureInstallationReady({ account: "acct-concurrent", auth: AUTH, fetchImpl }),
  ])
  assert.equal(calls.filter((x) => x.url.includes(PROFILE_PATH)).length, 1, "profile 只能一次")
  assert.equal(calls.filter((x) => x.url.includes(REGISTER_PATH)).length, 1, "注册只能一次")
  assert.deepEqual(a.installationId, b.installationId)
  assert.deepEqual(b.installationId, c.installationId)
})

test("activities：不发幂等键头，canonical 第 7 段为空", async () => {
  clearInstallation("acct-no-idem")
  _resetInflight()
  const { calls, fetchImpl } = recorder(ROUTES)
  await ensureInstallationReady({ account: "acct-no-idem", auth: AUTH, fetchImpl })

  const activity = calls.find((c) => c.url.includes(ACTIVITY_SUMMARY_PATH))
  assert.equal("idempotency-key" in activity.init.headers, false, "activities 不能带幂等键头")
  assert.ok(activity.init.headers["x-desktop-signature"])

  const body = JSON.parse(activity.init.body)
  assert.deepEqual(Object.keys(body), ["inference_public_key"])
  // 绑的是 **inference** 那把（不是 identity / device）—— 三把密钥分工的断言
  const record = readInstallation("acct-no-idem")
  assert.equal(body.inference_public_key, record.inferencePublicKey)
  assert.notEqual(body.inference_public_key, record.publicKey)
  assert.notEqual(body.inference_public_key, record.devicePublicKey)
})

test("注册失败 → 抛错且不伪装成功（不写 registeredAt/令牌）", async () => {
  clearInstallation("acct-fail")
  _resetInflight()
  const { fetchImpl } = recorder({
    ...ROUTES,
    [REGISTER_PATH]: { status: 409, body: { error: { code: "desktop_installation_conflict", message: "mismatch" } } },
  })
  await assert.rejects(
    () => ensureInstallationReady({ account: "acct-fail", auth: AUTH, fetchImpl }),
    (error) => error?.status === 409,
  )
  const record = readInstallation("acct-fail")
  assert.ok(!record?.registeredAt, "失败不能留下“已注册”")
  assert.ok(!record?.inferenceToken, "失败不能留下令牌")
})

test("profile 缺 account.uuid → 抛 internal_error，且不发注册", async () => {
  clearInstallation("acct-no-uuid")
  _resetInflight()
  const { calls, fetchImpl } = recorder({ ...ROUTES, [PROFILE_PATH]: { status: 200, body: { account: {} } } })
  await assert.rejects(
    () => ensureInstallationReady({ account: "acct-no-uuid", auth: AUTH, fetchImpl }),
    (error) => error?.code === "internal_error",
  )
  assert.equal(calls.filter((c) => c.url.includes(REGISTER_PATH)).length, 0)
})

test("409 熔断：失败一次后落盘，期内再调用零请求", async () => {
  clearInstallation("acct-breaker")
  _resetInflight()
  let clock = 1_700_000_000_000
  const { calls, fetchImpl } = recorder({
    ...ROUTES,
    [REGISTER_PATH]: { status: 409, body: { error: { code: "desktop_installation_conflict", message: "mismatch" } } },
  })

  await assert.rejects(
    () => ensureInstallationReady({ account: "acct-breaker", auth: AUTH, fetchImpl, now: () => clock }),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, "device_binding_conflict")
      assert.match(error.message, /账号级绑定|不接受第二台/)
      assert.equal(error.installationIdMasked.includes(SCOPE), false, "错误里不能出现完整 installationId")
      return true
    },
  )

  const record = readInstallation("acct-breaker")
  assert.ok(record.registrationUnavailableAt > 0, "熔断时间必须落盘")
  assert.equal(isRegistrationBlocked(record, () => clock), true)
  assert.equal(record.installationIdMasked, maskInstallationId(record.installationId))

  // 期内：零请求直接抛同一条错误
  const during = recorder(ROUTES)
  _resetInflight()
  await assert.rejects(
    () => ensureInstallationReady({ account: "acct-breaker", auth: AUTH, fetchImpl: during.fetchImpl, now: () => clock }),
    (error) => error.code === "device_binding_conflict",
  )
  assert.equal(during.calls.length, 0, "熔断期内不能发任何请求")

  // 过了窗口才允许再试一次
  clock += REGISTRATION_COOLDOWN_MS + 1
  const after = recorder({ ...ROUTES, [REGISTER_PATH]: { status: 200, body: { ok: true } } })
  _resetInflight()
  const record2 = await ensureInstallationReady({ account: "acct-breaker", auth: AUTH, fetchImpl: after.fetchImpl, now: () => clock })
  assert.ok(after.calls.length > 0, "窗口外应重新尝试")
  assert.ok(record2.inferenceToken, "重试成功后应拿到令牌")
})

test("安装记录里的 installationId 只留前 8 位用于报告", () => {
  assert.equal(maskInstallationId("XCkLb13vz-X-1R08fw1fePluUhb3gJYbMNYMwSoPU3U"), "XCkLb13v…")
  assert.equal(maskInstallationId(""), "<none>")
  assert.equal(maskInstallationId(undefined), "<none>")
})

test("就绪判定认 id 与公钥同源：旧记录（scope 哈希 id）即使有令牌也不算就绪", async () => {
  clearInstallation("acct-stale-id")
  const { record } = (await import("../src/device-key.mjs")).ensureInstallation({ account: "acct-stale-id" })
  const ready = { ...record, accountScope: SCOPE, registeredAt: 1, inferenceToken: fakeInferenceToken({ inferencePublicKey: record.inferencePublicKey }) }
  assert.equal(isInstallationReady(ready), true, "id 与公钥同源时算就绪")

  const stale = { ...ready, installationId: "di_legacyScopeHash000000000000000000000000" }
  assert.equal(isInstallationReady(stale), false, "id 与公钥不一致 ⇒ 不能拿错 id 去签名")

  const brokenKey = { ...ready, publicKey: "not-a-key" }
  assert.equal(isInstallationReady(brokenKey), false, "公钥坏了也不能算就绪（派生会抛）")
})