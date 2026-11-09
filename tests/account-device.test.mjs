// tests/account-device.test.mjs —— 账号 ↔ 设备身份的稳定绑定（离线，假 fetch + 临时 HOME）
//
// 这一组锁三条真实故障：
//
//   ① **用户点签到、但设备还没注册** —— 旧实现直接回「先发一次模型请求」，
//      用户点不动。正确行为：在 checkin 内走既有的 ensureInstallationReady
//      （profile → register → activities），拿到设备身份后**立刻**签到；
//      注册失败（409 / 403 / profile 缺 uuid）如实返回失败，不伪造 claimed。
//
//   ② **同一账号换 token 就换设备** —— magpie 对 `type: "api"` 的登录态只持久化
//      `{ type, key, metadata }`，顶层的 `uid` / `accountScope` / `expires` 会丢。
//      所以稳定身份只能落在 `metadata.userId` / `metadata.accountScope` 里
//      （`uidOf()` 本来就优先读 `metadata.userId`）。换 token 不换 installationId。
//
//   ③ **两个同名账号串身份** —— 设备记录按 `uid` 落盘，`accountId` 只是显示名。
//      同名、同 email 的两个账号必须各自一条记录、各自一把私钥。
//
// 另外两条边界：
//   · 旧记录（键是「凭据指纹」）能按 `accountScope` 被找回并迁移 —— 不重新注册，
//     也不复制/共用另一个账号的私钥；
//   · 签到链**不发起推理请求**（不碰 /v1/messages）。
//
// 全部离线：没有注入 fetch 的出站会被 tests/helpers/network-guard.mjs 拦成失败。

import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ⚠ 先重定向 HOME，再动态 import —— 安装记录写 ~/.cache/magpie，本机导入读 ~/.phanthy-code
const home = mkdtempSync(join(tmpdir(), "pw-account-device-"))
process.env.USERPROFILE = home
process.env.HOME = home
delete process.env.PHANTHY_ALLOW_DEVICE_REGISTER
delete process.env.PHANTHY_ALLOW_LOCAL_IMPORT

const { PhanthyCodeAuthPlugin } = await import("../index.mjs")
const { fingerprint, uidOf } = await import("../src/credential.mjs")
const {
  clearInstallation,
  ensureInstallation,
  findInstallationByScope,
  installationFile,
  readInstallation,
  saveInstallation,
} = await import("../src/device-key.mjs")
const { ensureInstallationReady, _resetInflight } = await import("../src/production-auth.mjs")
const { installationIdFromPublicKey } = await import("../src/installation-id.mjs")
const { fakeInferenceToken } = await import("./helpers/inference-token.mjs")
const { PROFILE_PATH, ACTIVITY_SUMMARY_PATH } = await import("../src/phanthy-api.mjs")
const { REGISTER_PATH } = await import("../src/registration.mjs")
const { TOKEN_PATH } = await import("../src/oauth.mjs")
const { DAILY_CLAIM_PATH, REWARDS_PATH } = await import("../src/activity.mjs")

after(() => rmSync(home, { recursive: true, force: true }))

beforeEach(() => {
  _resetInflight()
  delete process.env.PHANTHY_ALLOW_DEVICE_REGISTER
  // 每个用例一份干净的设备记录表：这一组用例共用 SCOPE_A / SCOPE_B，
  // 而「按作用域找回设备」正是被测行为 —— 上一条用例留下的记录会被合法找回，
  // 让「本该注册」的断言失效（测试隔离，不是产品行为）。
  rmSync(join(home, ".cache", "magpie"), { recursive: true, force: true })
})

const SCOPE_A = "11111111-1111-4111-8111-111111111111"
const SCOPE_B = "22222222-2222-4222-8222-222222222222"

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** 按 pathname 记账的假请求器（`/api/oauth/usage` 是 `/summary` 的前缀，不能用 includes） */
function recorder(routes = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const text = String(url)
    const path = new URL(text).pathname
    calls.push({ url: text, path, init })
    const spec = routes[path]
    if (!spec) throw new Error(`未预置路由：${path}（离线测试不许打真网）`)
    const out = typeof spec === "function" ? await spec(text, init) : spec
    return json(out.body ?? {}, out.status ?? 200)
  }
  const paths = () => calls.map((c) => c.path)
  const hits = (path) => paths().filter((p) => p === path).length
  return { calls, paths, hits, fetchImpl }
}

/** 一个「注册成功 + 签到成功」的服务端 */
function happyRoutes(scope = SCOPE_A, { claimStatus = 200, displayName = "测试账号" } = {}) {
  return {
    [PROFILE_PATH]: { body: { account: { uuid: scope, display_name: displayName } } },
    [REGISTER_PATH]: { body: { ok: true } },
    [ACTIVITY_SUMMARY_PATH]: (_url, init) => {
      const sent = JSON.parse(init?.body ?? "{}")
      return {
        body: {
          desktop_inference_token: fakeInferenceToken({ inferencePublicKey: sent.inference_public_key ?? "" }),
          server_time: 1,
        },
      }
    },
    [REWARDS_PATH]: { body: { wallet: { availablePoints: 100 }, daily: { server_date: "2026-11-09" } } },
    [DAILY_CLAIM_PATH]: { body: {}, status: claimStatus },
  }
}

/** 模拟 magpie 对 api 型登录态的持久化：只留 { type, key, metadata } */
function persistApiLogin(result) {
  return { type: "api", key: result.key, metadata: { ...(result.metadata ?? {}) } }
}

function writeImportedCredentials(access) {
  const dir = join(home, ".phanthy-code")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: access,
        expiresAt: Date.now() + 3_600_000,
        scopes: ["user:inference"],
      },
    }),
  )
}

// ── ① 签到必须先自己把设备身份准备好 ─────────────────────────────────

test("未注册账号点签到 → 按序 profile → register → activities → rewards → claim，并报 claimed", async () => {
  const account = fingerprint(SCOPE_A)
  clearInstallation(account)

  const { calls, paths, hits, fetchImpl } = recorder(happyRoutes())
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const auth = { type: "api", key: "token-1", metadata: { userId: account, accountScope: SCOPE_A } }

  const result = await plugin.auth.checkin(async () => auth, { id: "phanthycode" })

  assert.equal(result.outcome, "claimed", `签到必须真的完成（实际：${JSON.stringify(result)}）`)
  assert.deepEqual(paths().slice(0, 3), [PROFILE_PATH, REGISTER_PATH, ACTIVITY_SUMMARY_PATH], "注册必须按官方顺序")
  assert.equal(hits(REGISTER_PATH), 1, "只注册一次")
  assert.ok(hits(REWARDS_PATH) >= 1, "注册完必须真的读签到状态")
  assert.equal(hits(DAILY_CLAIM_PATH), 1, "必须真的发起领取")

  // 设备身份落盘且是官方派生值
  const record = readInstallation(account)
  assert.ok(record?.registeredAt > 0, "注册成功必须落盘")
  assert.equal(record.installationId, installationIdFromPublicKey(record.publicKey))
  assert.equal(record.accountScope, SCOPE_A)

  // 签到链不能碰推理面
  assert.equal(calls.some((c) => /\/v1\//.test(c.path) || /messages/.test(c.path)), false, "签到不发起推理请求")
  // 也不能再让用户「先发一次模型请求」
  assert.equal(/先发一次模型请求/.test(result.message ?? ""), false)
})

test("设备已就绪 → 签到零注册零 profile（有效缓存不重复注册）", async () => {
  const account = fingerprint(SCOPE_A)
  clearInstallation(account)
  const first = recorder(happyRoutes())
  await ensureInstallationReady({
    account,
    auth: { type: "api", key: "tok", metadata: { userId: account, accountScope: SCOPE_A } },
    fetchImpl: first.fetchImpl,
  })

  const second = recorder(happyRoutes())
  _resetInflight()
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: second.fetchImpl })
  const result = await plugin.auth.checkin(
    async () => ({ type: "api", key: "tok", metadata: { userId: account, accountScope: SCOPE_A } }),
    { id: "phanthycode" },
  )

  assert.equal(result.outcome, "claimed")
  assert.equal(second.hits(REGISTER_PATH), 0, "已注册就不能再注册")
  assert.equal(second.hits(PROFILE_PATH), 0, "已注册就不必再问 profile")
  assert.equal(second.hits(ACTIVITY_SUMMARY_PATH), 0, "令牌还新鲜，不必再换")
})

test("注册 409（账号级设备绑定）→ 如实失败，绝不假报签到成功、不发领取", async () => {
  const account = fingerprint(SCOPE_A)
  clearInstallation(account)
  const routes = happyRoutes()
  routes[REGISTER_PATH] = {
    status: 409,
    body: { error: { code: "desktop_installation_conflict", message: "identifier does not match its public key" } },
  }
  const { hits, fetchImpl } = recorder(routes)
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })

  const result = await plugin.auth.checkin(
    async () => ({ type: "api", key: "tok", metadata: { userId: account, accountScope: SCOPE_A } }),
    { id: "phanthycode" },
  )

  assert.equal(result.outcome, "failed", "409 不能变成 claimed/done")
  assert.match(result.message, /设备/, "失败说明要点出「设备注册」这一步")
  assert.match(result.message, /409|绑定/, "失败说明要保留真实原因（409 / 账号级绑定）")
  assert.equal(hits(ACTIVITY_SUMMARY_PATH), 0, "注册失败后不许继续换令牌")
  assert.equal(hits(REWARDS_PATH), 0, "注册失败后不许读签到状态")
  assert.equal(hits(DAILY_CLAIM_PATH), 0, "注册失败后不许发领取")
  // 熔断事实落盘，下一次不重复触发风控
  assert.ok(readInstallation(account)?.registrationUnavailableAt > 0)
})

test("注册 403 → 如实失败（不伪造成功、不发领取）", async () => {
  const account = fingerprint(SCOPE_A)
  clearInstallation(account)
  const routes = happyRoutes()
  routes[REGISTER_PATH] = { status: 403, body: { error: { code: "forbidden", message: "device register forbidden" } } }
  const { hits, fetchImpl } = recorder(routes)
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })

  const result = await plugin.auth.checkin(
    async () => ({ type: "api", key: "tok", metadata: { userId: account, accountScope: SCOPE_A } }),
    { id: "phanthycode" },
  )

  assert.equal(result.outcome, "failed")
  assert.match(result.message, /403/, "403 要原样说清")
  assert.equal(hits(DAILY_CLAIM_PATH), 0)
})

test("profile 缺 account.uuid → 签到失败且一条注册都不发（不猜作用域）", async () => {
  const account = fingerprint(SCOPE_A)
  clearInstallation(account)
  const routes = happyRoutes()
  routes[PROFILE_PATH] = { body: { account: {} } }
  const { hits, fetchImpl } = recorder(routes)
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })

  const result = await plugin.auth.checkin(
    async () => ({ type: "api", key: "tok", metadata: { userId: account } }),
    { id: "phanthycode" },
  )

  assert.equal(result.outcome, "failed")
  assert.equal(hits(REGISTER_PATH), 0, "没有 accountScope 不许注册（那是猜）")
  assert.equal(hits(DAILY_CLAIM_PATH), 0)
})

// L-8：**网络错误**（fetch 直接 reject，没有 HTTP 状态码）是唯一还没有用例的失败分支。
// 判据三条：outcome 必须是 failed（不是 claimed/done）、**不读** rewards、**不领**奖；
// 也不能留下「已注册」的假记录 —— 否则下一次会被当成设备已就绪、拿一把服务端没认过的
// 公钥去签名。
test("注册阶段网络错误 → 签到如实失败，不读 rewards、不领取（L-8）", async () => {
  const account = fingerprint(SCOPE_A)
  clearInstallation(account)
  const routes = happyRoutes()
  routes[REGISTER_PATH] = () => {
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND code.phanthy.com")
  }
  const { hits, fetchImpl } = recorder(routes)
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })

  const result = await plugin.auth.checkin(
    async () => ({ type: "api", key: "tok", metadata: { userId: account, accountScope: SCOPE_A } }),
    { id: "phanthycode" },
  )

  assert.equal(result.outcome, "failed", `网络错误不能变成 claimed/done（实际：${JSON.stringify(result)}）`)
  assert.match(result.message ?? "", /网络|fetch|ENOTFOUND|设备/i, "失败说明要带得出真实原因")
  assert.equal(hits(REWARDS_PATH), 0, "注册没成功不许读签到状态")
  assert.equal(hits(DAILY_CLAIM_PATH), 0, "注册没成功不许发领取")
  assert.equal(hits(ACTIVITY_SUMMARY_PATH), 0, "注册没成功不许换推理令牌")
  assert.equal(readInstallation(account)?.registeredAt ?? 0, 0, "失败不能留下“已注册”")
  assert.equal(readInstallation(account)?.inferenceToken ?? "", "", "失败不能留下令牌")
})

// ── ② api 登录：稳定身份只活在 metadata 里 ───────────────────────────

test("api 登录把稳定身份写进 metadata（userId / accountScope），顶层丢了也不影响", async () => {
  writeImportedCredentials("imported-token-1")
  const { paths, fetchImpl } = recorder(happyRoutes(SCOPE_A, { displayName: "张三" }))
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })

  const result = await plugin.auth.methods[1].authorize()

  assert.equal(result.type, "success", `本机导入应成功：${result.error ?? ""}`)
  assert.equal(result.metadata?.userId, fingerprint(SCOPE_A), "稳定 uid 必须进 metadata（宿主只留这一层）")
  assert.equal(result.metadata?.accountScope, SCOPE_A, "accountScope 也要进 metadata")
  assert.equal(result.metadata?.email, "张三")
  assert.equal(result.uid, fingerprint(SCOPE_A), "顶层 uid 仍写（oauth 型会留）")

  // 宿主的真实持久化形状：顶层 uid/accountScope 全丢
  const persisted = persistApiLogin(result)
  assert.equal(uidOf(persisted), fingerprint(SCOPE_A), "换 token 前：uid 仍稳定")

  // 登录即分配本机设备身份：**纯本地**（三把密钥 + installationId），不发任何请求
  const device = readInstallation(result.metadata.userId)
  assert.ok(device?.installationId, "登录后本机就该有该账号独立的设备身份")
  assert.equal(device.installationId, installationIdFromPublicKey(device.publicKey))
  assert.equal(device.accountScope, SCOPE_A)
  assert.equal(device.registeredAt, 0, "登录不强制云端注册")
  assert.equal(device.inferenceToken, "", "登录不换推理令牌")
  assert.deepEqual(paths(), [PROFILE_PATH], "登录只允许一次 profile（不注册、不签到、不推理）")
})

test("同一账号换 token → 仍是同一 installationId（不重复注册、不换设备）", async () => {
  writeImportedCredentials("imported-token-1")
  const firstRoutes = recorder(happyRoutes(SCOPE_A, { displayName: "张三" }))
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: firstRoutes.fetchImpl })
  const login1 = await plugin.auth.methods[1].authorize()
  const auth1 = persistApiLogin(login1)

  const account = uidOf(auth1)
  clearInstallation(account)
  const first = recorder(happyRoutes(SCOPE_A, { displayName: "张三" }))
  const record1 = await ensureInstallationReady({ account, auth: auth1, fetchImpl: first.fetchImpl })

  // 换一张 token（同一账号），重新登录
  writeImportedCredentials("imported-token-2")
  const secondRoutes = recorder(happyRoutes(SCOPE_A, { displayName: "张三" }))
  const again = await PhanthyCodeAuthPlugin({}, { fetch: secondRoutes.fetchImpl })
  const login2 = await again.auth.methods[1].authorize()
  const auth2 = persistApiLogin(login2)

  assert.equal(auth1.key === auth2.key, false, "前提：token 真的变了")
  assert.equal(uidOf(auth2), uidOf(auth1), "uid 不能跟着 token 变")

  const second = recorder(happyRoutes(SCOPE_A, { displayName: "张三" }))
  _resetInflight()
  const record2 = await ensureInstallationReady({ account: uidOf(auth2), auth: auth2, fetchImpl: second.fetchImpl })

  assert.equal(record2.installationId, record1.installationId, "同账号换票必须是同一台设备")
  assert.equal(record2.publicKey, record1.publicKey)
  assert.equal(second.hits(REGISTER_PATH), 0, "已有设备身份就不要再注册")
})

// ── ③ 同名 / 不同账号不能串 ─────────────────────────────────────────

test("同名同 email 的两个账号：uid 不同、设备记录不同、私钥不共用", async () => {
  const accountA = fingerprint(SCOPE_A)
  const accountB = fingerprint(SCOPE_B)
  clearInstallation(accountA)
  clearInstallation(accountB)

  const { fetchImpl } = recorder(happyRoutes(SCOPE_A, { displayName: "重名" }))
  const pluginA = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const authA = { type: "api", key: "a", metadata: { email: "重名", userId: accountA, accountScope: SCOPE_A } }

  const pluginB = await PhanthyCodeAuthPlugin(
    {},
    { fetch: recorder(happyRoutes(SCOPE_B, { displayName: "重名" })).fetchImpl },
  )
  const authB = { type: "api", key: "b", metadata: { email: "重名", userId: accountB, accountScope: SCOPE_B } }

  assert.equal(authA.metadata.email, authB.metadata.email, "前提：显示名相同")
  assert.notEqual(uidOf(authA), uidOf(authB), "同名不能同 uid")

  const firstA = recorder(happyRoutes(SCOPE_A, { displayName: "重名" }))
  const firstB = recorder(happyRoutes(SCOPE_B, { displayName: "重名" }))
  const recordA = await ensureInstallationReady({ account: uidOf(authA), auth: authA, fetchImpl: firstA.fetchImpl })
  const recordB = await ensureInstallationReady({ account: uidOf(authB), auth: authB, fetchImpl: firstB.fetchImpl })

  assert.notEqual(recordA.installationId, recordB.installationId, "两个账号必须是两台设备")
  assert.notEqual(recordA.publicKey, recordB.publicKey)
  assert.notEqual(recordA.privateKey, recordB.privateKey, "私钥绝不能共用")
  assert.equal(recordA.accountScope, SCOPE_A)
  assert.equal(recordB.accountScope, SCOPE_B)

  // 按作用域找回的也必须是各自那条
  assert.equal(findInstallationByScope(SCOPE_A).installationId, recordA.installationId)
  assert.equal(findInstallationByScope(SCOPE_B).installationId, recordB.installationId)

  // 两边签到各用各的设备
  const callsA = recorder(happyRoutes(SCOPE_A))
  const resultA = await (await PhanthyCodeAuthPlugin({}, { fetch: callsA.fetchImpl })).auth.checkin(
    async () => authA,
    { id: "phanthycode" },
  )
  assert.equal(resultA.outcome, "claimed")
  const used = callsA.calls.find((c) => c.path === REWARDS_PATH).init.headers["x-desktop-installation-id"]
  assert.equal(used, recordA.installationId, "A 的签到只能签 A 的设备")
})

test("oauth 登录也把稳定身份写进 metadata（卡片名 + 稳定 uid）", async () => {
  const { paths, fetchImpl } = recorder({
    [TOKEN_PATH]: { body: { access_token: "access-oauth", refresh_token: "refresh-oauth", expires_in: 1800 } },
    [PROFILE_PATH]: { body: { account: { uuid: SCOPE_A, display_name: "+86 178****4697" } } },
  })
  let closed = 0
  const isolatedLogin = async () => ({
    ok: true,
    error: null,
    child: { once: () => {} },
    close: async () => {
      closed += 1
      return { killed: false, removedDir: true }
    },
  })
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl, isolatedLogin })
  const method = plugin.auth.methods[0]
  const flow = await method.authorize()
  assert.equal(flow.opened, true, "生产 OAuth 必须由插件打开隔离浏览器")
  assert.match(flow.instructions, /独立登录窗口|不带你日常浏览器/)
  const result = await flow.callback("oauth-code")
  assert.equal(closed, 1, "callback 结束必须清理本次隔离浏览器")
  assert.equal(result.type, "success", `oauth 换票应成功：${result.error ?? ""}`)
  assert.equal(result.accountId, "+86 178****4697")
  assert.equal(result.uid, fingerprint(SCOPE_A))
  assert.equal(result.metadata?.userId, fingerprint(SCOPE_A), "oauth 也要写 metadata.userId")
  assert.equal(result.metadata?.accountScope, SCOPE_A)

  // 登录即分配本机设备身份（纯本地），且 authorize 不新增云端调用
  const device = readInstallation(result.metadata.userId)
  assert.ok(device?.installationId, "oauth 登录后本机也该有设备身份")
  assert.equal(device.installationId, installationIdFromPublicKey(device.publicKey))
  assert.equal(device.registeredAt, 0, "登录不强制云端注册")
  assert.deepEqual(paths(), [TOKEN_PATH, PROFILE_PATH], "oauth 登录只允许换票 + profile")
})

test("oauth 隔离浏览器启动失败：关闭 loopback、如实失败且不换票", async () => {
  const { paths, fetchImpl } = recorder({})
  const plugin = await PhanthyCodeAuthPlugin({}, {
    fetch: fetchImpl,
    isolatedLogin: async () => ({ ok: false, error: "spawn ENOENT" }),
  })
  const flow = await plugin.auth.methods[0].authorize()
  assert.equal(flow.type, "failed")
  assert.match(flow.error, /隔离登录浏览器|ENOENT/)
  assert.equal(flow.callback, undefined, "启动失败不能返回一个会继续换票的 callback")
  assert.deepEqual(paths(), [], "启动失败不得发起任何云端请求")
})

// ── ④ refresh 不许把稳定身份冲掉 ─────────────────────────────────────

test("refresh：profile 补名字时不得冲掉 metadata.userId / accountScope", async () => {
  const { fetchImpl } = recorder({
    [TOKEN_PATH]: { body: { access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 1800 } },
    [PROFILE_PATH]: { body: { account: { uuid: SCOPE_A, display_name: "新名字" } } },
  })
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  // 老记录：有 metadata.userId / accountScope，但没有 accountId（续期时会补名字）
  const auth = {
    type: "oauth",
    access: "old-access",
    refresh: "refresh-token-1",
    uid: fingerprint(SCOPE_A),
    metadata: { userId: fingerprint(SCOPE_A), accountScope: SCOPE_A },
  }
  const result = await plugin.auth.refresh(auth)
  const merged = { ...auth, ...result } // 宿主 refresh 是合并

  assert.equal(result.metadata?.userId, fingerprint(SCOPE_A), "refresh 返回值必须带 userId")
  assert.equal(result.metadata?.accountScope, SCOPE_A, "refresh 返回值必须带 accountScope")
  assert.equal(result.metadata?.email, "新名字")
  assert.equal(result.uid, fingerprint(SCOPE_A), "refresh 不能退回凭据指纹")
  assert.equal(uidOf(merged), fingerprint(SCOPE_A), "合并后 uid 仍稳定")
})

test("refresh：不需要换名字时也显式保留 metadata（不依赖宿主的合并方向）", async () => {
  const { fetchImpl } = recorder({
    [TOKEN_PATH]: { body: { access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 1800 } },
  })
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const auth = {
    type: "oauth",
    access: "old-access",
    refresh: "refresh-token-2",
    accountId: "老名字",
    uid: fingerprint(SCOPE_A),
    accountScope: SCOPE_A,
    metadata: { email: "老名字", userId: fingerprint(SCOPE_A), accountScope: SCOPE_A },
  }
  const result = await plugin.auth.refresh(auth)

  assert.equal(result.metadata?.userId, fingerprint(SCOPE_A))
  assert.equal(result.metadata?.accountScope, SCOPE_A)
  assert.equal(result.metadata?.email, "老名字")
  assert.equal(result.uid, fingerprint(SCOPE_A))
})

// ── ⑤ 旧记录（凭据指纹键）按 accountScope 找回并迁移 ─────────────────

test("旧 token 指纹记录：按 accountScope 找回，同一个 installationId，不重新注册", async () => {
  const oldKey = fingerprint("old-imported-token")
  const newKey = fingerprint(SCOPE_A)
  clearInstallation(oldKey)
  clearInstallation(newKey)

  const { record } = ensureInstallation({ account: oldKey })
  saveInstallation(oldKey, {
    ...record,
    accountScope: SCOPE_A,
    registeredAt: 1,
    inferenceToken: fakeInferenceToken({ inferencePublicKey: record.inferencePublicKey }),
  })

  const { calls, hits, fetchImpl } = recorder(happyRoutes(SCOPE_A))
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const auth = { type: "api", key: "new-token", metadata: { userId: newKey, accountScope: SCOPE_A } }

  const result = await plugin.auth.checkin(async () => auth, { id: "phanthycode" })

  assert.equal(result.outcome, "claimed")
  assert.equal(hits(REGISTER_PATH), 0, "旧设备记录能复用，绝不能再注册一台")
  const used = calls.find((c) => c.path === REWARDS_PATH).init.headers["x-desktop-installation-id"]
  assert.equal(used, record.installationId, "签的必须是旧记录那台设备")

  // 迁移到稳定键，旧文件清掉（同一个账号自己的记录，不是别人的）
  const migrated = readInstallation(newKey)
  assert.equal(migrated?.installationId, record.installationId)
  assert.equal(migrated?.publicKey, record.publicKey)
  assert.equal(readInstallation(oldKey), null, "旧键记录迁移后应清掉，避免磁盘上留孤儿")
})

test("没有 accountScope 的旧记录无法证明归属：先问 profile，再注册本账号自己的设备", async () => {
  // 为什么不能复用：adopt 的判据是 `accountScope` **完全相等**。一条没写 scope 的旧记录
  // 与任何账号都「不相等」，凭它自己的键（凭据指纹）又推不出当前的稳定 uid ——
  // 强行复用等于把一条无法证明归属的私钥当成这个账号的设备（可能正是别人的）。
  // 所以这里只做两件事：问一次 profile 拿到 scope，然后注册本账号自己的设备。
  const oldKey = fingerprint("legacy-token")
  const newKey = fingerprint(SCOPE_A)
  clearInstallation(oldKey)
  clearInstallation(newKey)

  const { record } = ensureInstallation({ account: oldKey })
  saveInstallation(oldKey, {
    ...record,
    accountScope: "",
    registeredAt: 1,
    inferenceToken: fakeInferenceToken({ inferencePublicKey: record.inferencePublicKey }),
  })

  const { hits, fetchImpl } = recorder(happyRoutes(SCOPE_A))
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const result = await plugin.auth.checkin(
    // 稳定 uid 已知（登录时写进 metadata），但本机还没有这个键下的记录
    async () => ({ type: "api", key: "brand-new-token", metadata: { userId: newKey } }),
    { id: "phanthycode" },
  )

  assert.equal(result.outcome, "claimed")
  assert.equal(hits(PROFILE_PATH) >= 1, true, "缺 scope 时问一次 profile 是允许的（签到是用户显式动作）")
  assert.equal(hits(REGISTER_PATH), 1, "无法证明归属 ⇒ 注册本账号自己的设备")
  const fresh = readInstallation(newKey)
  assert.ok(fresh?.registeredAt > 0)
  assert.equal(fresh.accountScope, SCOPE_A)
  assert.notEqual(fresh.publicKey, record.publicKey, "不能把无法证明归属的私钥当成本账号的设备")
})

test("凭据切换后的人为空记录不会被当成另一台设备（不复制私钥）", async () => {
  const accountA = fingerprint(SCOPE_A)
  const accountB = fingerprint(SCOPE_B)
  clearInstallation(accountA)
  clearInstallation(accountB)

  const firstA = recorder(happyRoutes(SCOPE_A))
  const recordA = await ensureInstallationReady({
    account: accountA,
    auth: { type: "api", key: "a", metadata: { userId: accountA, accountScope: SCOPE_A } },
    fetchImpl: firstA.fetchImpl,
  })

  // B 登录：即使 metadata 里残留 A 的显示名，也不许复用 A 的设备
  const firstB = recorder(happyRoutes(SCOPE_B))
  _resetInflight()
  const recordB = await ensureInstallationReady({
    account: accountB,
    auth: { type: "api", key: "b", metadata: { email: "同一个显示名", userId: accountB } },
    fetchImpl: firstB.fetchImpl,
  })

  assert.equal(firstB.hits(REGISTER_PATH), 1, "B 必须自己注册一台设备")
  assert.notEqual(recordB.installationId, recordA.installationId)
  assert.notEqual(recordB.privateKey, recordA.privateKey)
  assert.equal(recordB.accountScope, SCOPE_B)
})
