// tests/loader-binding.test.mjs —— 设备绑定冲突在 loader 边界的语义（离线）
//
// 验收条款：409 必须是「账号级设备绑定」这一条明确错误，**不能**被宿主当成 OAuth 失效
// （那会停用整个账号），并且第二次调用零请求（熔断）。

import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "pw-loader-bind-"))
process.env.USERPROFILE = home
process.env.HOME = home

const { PhanthyCodeAuthPlugin } = await import("../index.mjs")
const { _resetInflight } = await import("../src/production-auth.mjs")
const { clearInstallation } = await import("../src/device-key.mjs")
const { PROFILE_PATH } = await import("../src/phanthy-api.mjs")
const { REGISTER_PATH } = await import("../src/registration.mjs")

after(() => rmSync(home, { recursive: true, force: true }))
beforeEach(() => _resetInflight())

const AUTH = { type: "oauth", access: "access-test", uid: "acct-bind" }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function recorder(routes) {
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

const BINDING_409 = {
  [PROFILE_PATH]: { status: 200, body: { account: { uuid: "8f14e45f-ceea-467a-9c1f-2b3d4e5f6a7b" } } },
  [REGISTER_PATH]: { status: 409, body: { error: { code: "desktop_installation_conflict", message: "identifier does not match its public key" } } },
}

test("默认**允许**注册（0.2.15 扭转语义）；显式设 0 才拒绝，且错误是 501 not_implemented", async () => {
  // 0.2.15 之前是「必须设 =1 才允许」。那个设计在真机上必然失败：
  // magpie 是独立进程，用户在 shell 里 set 的环境变量它看不到 ⇒
  // 登录成功、额度正常、模型 13 条，一发推理却回「推理面未接通」。
  // 现在默认允许，`=0` 是显式 opt-out。
  delete process.env.PHANTHY_ALLOW_DEVICE_REGISTER
  clearInstallation("acct-default")
  const { calls, fetchImpl } = recorder(BINDING_409)
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const loader = await plugin.auth.loader(async () => ({ ...AUTH, uid: "acct-default" }), { id: "phanthycode" })

  // 默认会真的去注册（这里服务端回 409，落到绑定冲突那条分支 —— 证明请求发出去了）
  await assert.rejects(
    () => loader.fetch("https://code.phanthy.com/v1/messages", { method: "POST", body: "{}" }),
    (error) => {
      assert.notEqual(error.status, 501, "默认不能再是「未接通」")
      assert.notEqual(error.signIn, "expired", "不能因为注册失败就停用整个账号")
      return true
    },
  )
  assert.ok(calls.length > 0, "默认配置下必须真的尝试注册")
})

test("显式 PHANTHY_ALLOW_DEVICE_REGISTER=0 → 一条请求都不发，501 说明怎么解除", async () => {
  process.env.PHANTHY_ALLOW_DEVICE_REGISTER = "0"
  clearInstallation("acct-no-register")
  const { calls, fetchImpl } = recorder(BINDING_409)
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const loader = await plugin.auth.loader(async () => ({ ...AUTH, uid: "acct-no-register" }), { id: "phanthycode" })

  await assert.rejects(
    () => loader.fetch("https://code.phanthy.com/v1/messages", { method: "POST", body: "{}" }),
    (error) => {
      // 审计 F2：opt-out ≠ 服务端已绑定官方桌面端公钥。409 是可退避的（宿主每轮重试），
      // 而真实原因是「推理面被显式关掉了」，所以用 501 + 说明怎么解除。
      assert.equal(error.status, 501)
      assert.equal(error.code, "not_implemented")
      assert.equal(error.signIn, undefined, "不能带 signIn：那会停用整个账号")
      assert.match(error.message, /PHANTHY_ALLOW_DEVICE_REGISTER/, "文案必须说清怎么解除")
      assert.doesNotMatch(error.message, /已绑定官方桌面端公钥/, "不能断言没验证过的结论")
      return true
    },
  )
  assert.equal(calls.length, 0, "显式 opt-out 时不能有任何请求")
  delete process.env.PHANTHY_ALLOW_DEVICE_REGISTER
})

test("loader 遇到 409：抛 device_binding_conflict，且不带 signIn（不杀账号）", async () => {
  process.env.PHANTHY_ALLOW_DEVICE_REGISTER = "1"
  delete process.env.PHANTHY_ALLOW_DEVICE_REGISTER
  process.env.PHANTHY_ALLOW_DEVICE_REGISTER = "1"
  clearInstallation("acct-bind")
  const { fetchImpl } = recorder(BINDING_409)
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const loader = await plugin.auth.loader(async () => AUTH, { id: "phanthycode" })

  await assert.rejects(
    () => loader.fetch("https://code.phanthy.com/v1/messages", { method: "POST", body: JSON.stringify({ model: "x" }) }),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, "device_binding_conflict")
      assert.equal(error.signIn, undefined, "不能带 signIn: expired —— 那会停用整个账号")
      assert.match(error.message, /账号级绑定|不接受第二台/)
      assert.equal(error.message.includes("8f14e45f-ceea"), false, "错误里不能出现完整 installationId")
      return true
    },
  )
})

test("第二次调用：熔断生效，零请求直接抛同一条错误", async () => {
  process.env.PHANTHY_ALLOW_DEVICE_REGISTER = "1"
  clearInstallation("acct-bind-2")
  const auth = { ...AUTH, uid: "acct-bind-2" }
  const first = recorder(BINDING_409)
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: first.fetchImpl })
  const loader = await plugin.auth.loader(async () => auth, { id: "phanthycode" })
  await assert.rejects(() => loader.fetch("https://code.phanthy.com/v1/messages", { method: "POST", body: "{}" }))

  _resetInflight()
  const second = recorder(BINDING_409)
  const plugin2 = await PhanthyCodeAuthPlugin({}, { fetch: second.fetchImpl })
  const loader2 = await plugin2.auth.loader(async () => auth, { id: "phanthycode" })
  await assert.rejects(
    () => loader2.fetch("https://code.phanthy.com/v1/messages", { method: "POST", body: "{}" }),
    (error) => error.code === "device_binding_conflict",
  )
  assert.equal(second.calls.length, 0, "熔断期内不能再发任何请求")
})

test("数据面不受影响：模型目录照常可用", async () => {
  const { fetchImpl } = recorder({
    "/api/phanthy_code/models": { status: 200, body: { schema_version: 1, default_model: "phanthy-fast", models: [{ id: "phanthy-fast", label: "Phanthy Fast" }] } },
  })
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const models = await plugin.provider.models({}, { auth: { ...AUTH, uid: "acct-data" } })
  assert.deepEqual(Object.keys(models), ["phanthy-fast"])
})
