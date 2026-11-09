// tests/invite-wire.test.mjs —— 邀请源接线（index.mjs 的「自动最新 / 首选」语义）
//
// 这份文件锁的是**用户最终确认的语义**（推翻旧的「开关关 = 不带邀请」）：
//
//   off（默认）= 自动：用「最新注册账号」的邀请链接；最新没码就回退上一个可用账号；
//                一个都没有 → 用户预留码；再没有 → 不带邀请、照常登录。
//   on         = 首选：只用 magpie 账号页「Make first」那个账号的码；
//                首选没码 / 不可用 → **只**回退预留码，不许静默换别的账号。
//
// 同时锁住「出站只发生在 ask()」这条铁律：
//   · ask() 负责算源 + 抓一次 `/r/<code>` 换 referral_state；
//   · authorize() 零出站（只读本次进程 Map），没有 state 就裸授权 URL；
//   · usage() / checkin() 只做**有界**采集（设备已注册、24h 一次、该 uid 还没码），
//     失败只记 reason，绝不影响主结果、绝不让签到变红、绝不 bind、绝不碰推理端点。
//
// 全程离线：临时 HOME + 假 fetch + 假 isolatedLogin，绝不真网络 / 真浏览器。

import { test, beforeEach, afterEach, after } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ⚠ 先重定向 HOME 再动态 import —— 邀请策略 / 账号索引 / 安装记录都写 ~/.cache/magpie，
//   首选账号解析读 ~/.config/magpie。
const HOME_DIR = mkdtempSync(join(tmpdir(), "pw-invite-wire-"))
process.env.HOME = HOME_DIR
process.env.USERPROFILE = HOME_DIR

const { PhanthyCodeAuthPlugin } = await import("../index.mjs")
const { BASE, PROVIDER } = await import("../src/context.mjs")
const { TOKEN_PATH } = await import("../src/oauth.mjs")
const { PROFILE_PATH, USAGE_PATH, USAGE_SUMMARY_PATH, WALLET_PATH } = await import("../src/phanthy-api.mjs")
const { REFERRAL_ME_PATH, REFERRAL_CODE_PATH } = await import("../src/referrals.mjs")
const { REWARDS_PATH, DAILY_CLAIM_PATH } = await import("../src/activity.mjs")
const { createInviteSourceStore } = await import("../src/invite-source.mjs")
const { createInviteStore } = await import("../src/invite.mjs")
const { saveInstallation } = await import("../src/device-key.mjs")
const { generateEd25519KeyPair } = await import("../src/proof.mjs")
const { installationIdFromPublicKey } = await import("../src/installation-id.mjs")
const { fakeInferenceToken } = await import("./helpers/inference-token.mjs")

const OPTION_KEY = "invite_mode"

after(() => rmSync(HOME_DIR, { recursive: true, force: true }))

beforeEach(() => {
  rmSync(join(HOME_DIR, ".cache"), { recursive: true, force: true })
  rmSync(join(HOME_DIR, ".config"), { recursive: true, force: true })
})

// ── 假件（不联网 / 不弹浏览器）────────────────────────────────────────

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** 分享页：`referral_state` 由 code 派生，用来断言「用的是谁的码」 */
function shareStateOf(code) {
  return `rs1.wire.${String(code).replace(/[^A-Za-z0-9._-]/g, "_")}`
}

function shareHtml(code) {
  return `<a href="/login?next=%2Foauth%2Fauthorize&amp;referral_state=${encodeURIComponent(shareStateOf(code))}">登录</a>`
}

/**
 * 记录调用的假请求器。`overrides` 的键可以是 `path` 或 `"METHOD path"`。
 * 未命中路由时按端点给「形状合法」的响应。
 */
function makeFetch(overrides = {}) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = String(input)
    const method = String(init?.method ?? "GET").toUpperCase()
    const path = new URL(url).pathname
    const call = { url, method, init, path }
    calls.push(call)

    const handler = overrides[`${method} ${path}`] ?? overrides[path]
    if (handler !== undefined) {
      const value = typeof handler === "function" ? await handler(call) : handler
      if (value instanceof Response) return value
      return json(value)
    }

    if (path.startsWith("/r/")) {
      const code = decodeURIComponent(path.slice("/r/".length))
      return new Response(shareHtml(code), { status: 200, headers: { "content-type": "text/html" } })
    }

    switch (path) {
      case TOKEN_PATH:
        return json({ access_token: "access-wire", refresh_token: "refresh-wire", expires_in: 1800 })
      case PROFILE_PATH:
        return json({ account: { uuid: "scope-wire", display_name: "+86 178****4697" } })
      case USAGE_PATH:
        return json({})
      case USAGE_SUMMARY_PATH:
        return json({ plan: { name: "Pro" } })
      case WALLET_PATH:
        return json({ wallet: { availablePoints: 10 } })
      case REWARDS_PATH:
        return json({ wallet: { availablePoints: 100 }, daily: { server_date: "2026-11-08" } })
      case DAILY_CLAIM_PATH:
        return json({})
      case REFERRAL_ME_PATH:
        return json({ referral: { eligible_to_invite: true } })
      case REFERRAL_CODE_PATH: {
        const code = "CODE-HARVEST"
        return json({ code, share_url: `${BASE}/r/${code}`, codes: [{ slot: 1, code, share_url: `${BASE}/r/${code}` }] })
      }
      default:
        return json({})
    }
  }
  fetchImpl.calls = calls
  fetchImpl.paths = () => calls.map((c) => c.path)
  fetchImpl.count = (path, method) =>
    calls.filter((c) => c.path === path && (!method || c.method === String(method).toUpperCase())).length
  /** 出站面：分享页 / referrals / 推理端点（用来断言「零出站」「零 bind」「零推理」） */
  fetchImpl.shareCalls = () => calls.filter((c) => c.path.startsWith("/r/"))
  fetchImpl.referralCalls = () => calls.filter((c) => c.path.startsWith("/api/oauth/referrals/"))
  return fetchImpl
}

/** 假隔离浏览器：记录每次启动，close 可断言 */
function fakeIsolatedLogin() {
  const launches = []
  const fn = async ({ url }) => {
    const launch = {
      ok: true,
      url,
      child: { once: () => {} },
      closed: 0,
      async close() {
        launch.closed += 1
        return { killed: false, removedDir: true }
      },
    }
    launches.push(launch)
    return launch
  }
  fn.launches = launches
  return fn
}

async function makePlugin({ option, fetchImpl } = {}) {
  const ctx = option === undefined ? {} : { magpie: { option } }
  const login = fakeIsolatedLogin()
  const fetch = fetchImpl ?? makeFetch()
  const plugin = await PhanthyCodeAuthPlugin(ctx, { fetch, isolatedLogin: login })
  return { plugin, method: plugin.auth.methods[0], login, fetch }
}

/** 开关打开（provider / key 都要对上） */
const onOption = () => (provider, key) => provider === PROVIDER && key === OPTION_KEY

// ── loopback 兜底清理 ────────────────────────────────────────────────
// 断言失败时往往还没走到 callback()，loopback Server 会一直开着，测试进程吊到 300s。
const openFlows = []

async function authorize(method, inputs) {
  const flow = await method.authorize(inputs)
  openFlows.push(flow)
  return flow
}

async function finish(flow, code) {
  try {
    return await flow.callback(code)
  } finally {
    const index = openFlows.indexOf(flow)
    if (index >= 0) openFlows.splice(index, 1)
  }
}

afterEach(async () => {
  for (const flow of openFlows.splice(0)) {
    try {
      await flow.callback("cleanup-code")
    } catch {
      // 兜底清理失败不改变测试结论
    }
  }
})

// ── 夹具：账号索引 / 预留码 / 首选账号 / 设备记录 ────────────────────

const sources = createInviteSourceStore(PROVIDER)
const reservedStore = createInviteStore(PROVIDER)

function seedAccount(uid, { accountScope = `scope-${uid}`, accountId = `name-${uid}`, at } = {}) {
  return sources.noteAccount({ uid, accountScope, accountId, ...(at === undefined ? {} : { at }) })
}

function seedCode(uid, code) {
  return sources.saveCode({ uid, code, shareUrl: `${BASE}/r/${code}`, slot: 1 })
}

/** 写 magpie 的账号页「Make first」夹具（logins.json + plugin-auth.json） */
function seedPreferred(uid, { home = "phanthycode#preferred", accountId = "首选账号" } = {}) {
  const dir = join(HOME_DIR, ".config", "magpie")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "logins.json"),
    JSON.stringify([{ id: "row-1", agent: `plugin:${PROVIDER}`, user: "u", home, first: true, order: 1 }]),
  )
  writeFileSync(
    join(dir, "plugin-auth.json"),
    JSON.stringify({ [home]: { metadata: { userId: uid, accountScope: "scope-preferred" }, accountId } }),
  )
}

/** 该账号自己的安装记录，且 `isDeviceRegistered` 为真（设备已注册，不是「有推理令牌」） */
function readyInstallation(account) {
  const identity = generateEd25519KeyPair()
  const device = generateEd25519KeyPair()
  const inference = generateEd25519KeyPair()
  saveInstallation(account, {
    account,
    installationId: installationIdFromPublicKey(identity.publicKeyB64Url),
    installationIdSource: "public_key",
    accountScope: "scope-wire",
    registeredAt: 1,
    publicKey: identity.publicKeyB64Url,
    privateKey: identity.privateKeyB64Url,
    devicePublicKey: device.publicKeyB64Url,
    devicePrivateKey: device.privateKeyB64Url,
    inferencePublicKey: inference.publicKeyB64Url,
    inferencePrivateKey: inference.privateKeyB64Url,
    inferenceToken: fakeInferenceToken({ inferencePublicKey: inference.publicKeyB64Url }),
    sessionId: "session-wire",
  })
}

function assertNoForbiddenOutbound(fetchImpl) {
  for (const call of fetchImpl.calls) {
    assert.doesNotMatch(call.url, /referrals\/bind/i, "登录 / 采集路径永不调用 bind")
    assert.doesNotMatch(call.url, /\/v1\/messages/i, "采集绝不碰推理端点")
    assert.doesNotMatch(call.url, /activities\/summary/i, "采集绝不签发推理令牌")
  }
}

// ═══ ① 声明：仍只有一个开关，文案是新语义 ═════════════════════════════

test("invite_mode 仍只有一个开关：新语义文案 + placement:top + 默认关闭 + 不新增登录方式", async () => {
  const { plugin } = await makePlugin()
  const options = plugin.auth.options

  assert.ok(Array.isArray(options), "auth.options 必须是数组")
  assert.equal(options.length, 1, "只允许一个 provider 级开关")

  const [o] = options
  assert.equal(o.key, OPTION_KEY)
  assert.equal(o.default, false, "默认关闭：不改变现有用户行为")
  assert.equal(o.placement, "top", "placement 必须是字符串 top（不是 top: true）")
  assert.equal("top" in o, false, "不能写 top: true —— magpie 的 optionsOf 不读它")

  assert.match(o.label, /邀请/, "label 要说清是邀请模式")
  assert.match(o.description, /最新|最近/, "关 = 自动用最新注册账号的邀请链接")
  assert.match(o.description, /首选|Make first/i, "开 = 用 magpie 首选账号")
  assert.match(o.description, /仅新注册账号/, "必须说明只对新注册账号生效")
  assert.deepEqual(o.labels, { zh: o.label })
  assert.deepEqual(o.descriptions, { zh: o.description })

  assert.deepEqual(plugin.auth.methods.map((m) => m.type), ["oauth", "api"], "不新增登录方式")
  assert.equal(plugin.auth.methods[0].prompts.length, 1, "自动源不该弹问题（不要逼用户填码）")
  assert.equal(plugin.auth.methods[0].prompts[0]?.key, "invite", "邀请码问题可留空 = 自动源")
})

// ═══ ② off：最新账号的码 ═════════════════════════════════════════════

test("off：最新账号有码 → ask 抓一次 /r/，authorize 包装 /login 且 next 逐字是授权 URL", async () => {
  const fetchImpl = makeFetch()
  seedAccount("uid-latest", { at: 1_000 })
  seedCode("uid-latest", "CODE-LATEST")
  // 更早的账号也有码 —— 必须用「最新」那个
  seedAccount("uid-older", { at: 500 })
  seedCode("uid-older", "CODE-OLDER")

  const { method, login } = await makePlugin({ fetchImpl })

  // ask：没有提问（自动源），只抓一次分享页
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null, "自动源不该返回问题")
  assert.deepEqual(
    fetchImpl.shareCalls().map((c) => c.path),
    ["/r/CODE-LATEST"],
    "off = 最新账号的邀请链接（不是更早那个）",
  )
  assert.equal(fetchImpl.shareCalls()[0].method, "GET")
  assert.equal(fetchImpl.shareCalls()[0].init.headers.authorization, undefined, "分享页是匿名 GET")
  assert.equal(fetchImpl.shareCalls()[0].init.redirect, "manual")

  // authorize：零出站，只读本次 Map
  const before = fetchImpl.calls.length
  const flow = await authorize(method, {})
  assert.equal(fetchImpl.calls.length, before, "authorize 期间 fetch 调用数必须为 0（出站只发生在 ask）")

  const url = new URL(flow.url)
  assert.equal(url.origin, BASE)
  assert.equal(url.pathname, "/login", "必须包进官方登录页")
  assert.deepEqual([...url.searchParams.keys()].sort(), ["next", "referral_state"])

  const next = url.searchParams.get("next")
  const nextUrl = new URL(next)
  assert.equal(nextUrl.origin, BASE)
  assert.equal(nextUrl.pathname, "/oauth/authorize")
  assert.ok(nextUrl.searchParams.get("state"), "next 里必须带 state")
  assert.ok(nextUrl.searchParams.get("code_challenge"), "next 里必须带 PKCE challenge")
  assert.match(nextUrl.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)
  assert.equal(url.searchParams.get("referral_state"), shareStateOf("CODE-LATEST"))
  // 单层编码：next 是百分号编码的 URL，不是二次编码
  assert.match(flow.url, /[?&]next=https%3A%2F%2F/)
  assert.doesNotMatch(flow.url, /next=https%253A/)

  // 文案：说明本次来源 + 只对新号有效，且不含 code / state 原值
  assert.match(flow.instructions, /最新/)
  assert.match(flow.instructions, /仅新注册账号有效/)
  assert.match(flow.instructions, /独立登录窗口|不带你日常浏览器/, "原有的隔离浏览器说明必须保留")
  assert.doesNotMatch(flow.instructions, /CODE-LATEST/, "文案不含邀请码原值")
  assert.doesNotMatch(flow.instructions, /rs1\.wire/, "文案不含 referral_state 原值")

  const result = await finish(flow, "oauth-code-latest")
  assert.equal(result.type, "success", result.error)

  // 换票用的 state / redirect_uri 必须与 next 里的一致 —— 证明包进去的就是这次授权 URL
  const tokenCall = fetchImpl.calls.find((c) => c.path === TOKEN_PATH)
  const form = new URLSearchParams(String(tokenCall.init.body))
  assert.equal(form.get("state"), nextUrl.searchParams.get("state"))
  assert.equal(form.get("redirect_uri"), nextUrl.searchParams.get("redirect_uri"))
  assert.equal(login.launches[0].closed, 1)
})

test("off：最新账号没码 → 回退上一个有码的账号", async () => {
  const fetchImpl = makeFetch()
  seedAccount("uid-older", { at: 500 })
  seedCode("uid-older", "CODE-OLDER")
  seedAccount("uid-latest", { at: 1_000 }) // 最新，但还没码

  const { method } = await makePlugin({ fetchImpl })
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null)
  assert.deepEqual(fetchImpl.shareCalls().map((c) => c.path), ["/r/CODE-OLDER"])

  const flow = await authorize(method, {})
  assert.equal(new URL(flow.url).searchParams.get("referral_state"), shareStateOf("CODE-OLDER"))
  assert.match(flow.instructions, /最新/)
  await finish(flow, "oauth-code-fallback")
})

test("off：都没码 → 回退预留码（零问题、零多余请求）", async () => {
  const fetchImpl = makeFetch()
  seedAccount("uid-latest", { at: 1_000 })
  reservedStore.write("CODE-RESERVED")

  const { method } = await makePlugin({ fetchImpl })
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null)
  assert.deepEqual(fetchImpl.shareCalls().map((c) => c.path), ["/r/CODE-RESERVED"])

  const flow = await authorize(method, {})
  assert.equal(new URL(flow.url).searchParams.get("referral_state"), shareStateOf("CODE-RESERVED"))
  assert.match(flow.instructions, /预留/)
  await finish(flow, "oauth-code-reserved")
})

test("off：账号没码、预留也没有 → 裸授权 URL 且零 /r/ 请求", async () => {
  const fetchImpl = makeFetch()
  seedAccount("uid-latest", { at: 1_000 })

  const { method } = await makePlugin({ fetchImpl })
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null)
  assert.equal(fetchImpl.shareCalls().length, 0, "没有码就零分享页请求")

  const flow = await authorize(method, {})
  assert.equal(new URL(flow.url).searchParams.get("next"), null, "没有 state 就裸授权 URL")
  assert.equal(new URL(flow.url).searchParams.get("referral_state"), null)
  assert.match(flow.instructions, /普通登录|没有可用/)
  assert.doesNotMatch(flow.instructions, /rs1\./)
  await finish(flow, "oauth-code-none")
})

// ═══ ③ on：只用首选账号的码 ═════════════════════════════════════════

test("on：首选有码 → 用首选（即使它不是最新账号）", async () => {
  const fetchImpl = makeFetch()
  seedPreferred("uid-preferred")
  seedAccount("uid-preferred", { at: 1_000 })
  seedCode("uid-preferred", "CODE-PREFERRED")
  seedAccount("uid-latest", { at: 2_000 })
  seedCode("uid-latest", "CODE-LATEST")

  const { method } = await makePlugin({ option: onOption(), fetchImpl })
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null)
  assert.deepEqual(fetchImpl.shareCalls().map((c) => c.path), ["/r/CODE-PREFERRED"], "on 只认首选账号")

  const flow = await authorize(method, {})
  assert.equal(new URL(flow.url).searchParams.get("referral_state"), shareStateOf("CODE-PREFERRED"))
  assert.match(flow.instructions, /首选/)
  await finish(flow, "oauth-code-preferred")
})

test("on：首选没码 → 只用预留码（断言没有用别的账号的码）", async () => {
  const fetchImpl = makeFetch()
  seedPreferred("uid-preferred")
  seedAccount("uid-preferred", { at: 1_000 }) // 首选还没码
  seedAccount("uid-latest", { at: 2_000 })
  seedCode("uid-latest", "CODE-LATEST") // 别的账号有码，但不许拿来用
  reservedStore.write("CODE-RESERVED")

  const { method } = await makePlugin({ option: onOption(), fetchImpl })
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null)
  assert.deepEqual(fetchImpl.shareCalls().map((c) => c.path), ["/r/CODE-RESERVED"], "首选没码 → 只回退预留")
  assert.equal(
    fetchImpl.shareCalls().some((c) => c.path === "/r/CODE-LATEST"),
    false,
    "绝不静默换成别的账号",
  )

  const flow = await authorize(method, {})
  assert.equal(new URL(flow.url).searchParams.get("referral_state"), shareStateOf("CODE-RESERVED"))
  assert.match(flow.instructions, /预留/)
  await finish(flow, "oauth-code-preferred-none")
})

test("on：首选 uid 为空（没配 Make first）→ 回退预留", async () => {
  const fetchImpl = makeFetch()
  seedAccount("uid-latest", { at: 1_000 })
  seedCode("uid-latest", "CODE-LATEST")
  reservedStore.write("CODE-RESERVED")

  const { method } = await makePlugin({ option: onOption(), fetchImpl })
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null)
  assert.deepEqual(fetchImpl.shareCalls().map((c) => c.path), ["/r/CODE-RESERVED"])

  const flow = await authorize(method, {})
  assert.equal(new URL(flow.url).searchParams.get("referral_state"), shareStateOf("CODE-RESERVED"))
  await finish(flow, "oauth-code-preferred-missing")
})

// ═══ ④ 用户手填：优先于自动源；0 / 1 沿用预留 ═════════════════════════

test("用户手填码优先于自动源；填 0 / 1 沿用预留", async () => {
  const fetchImpl = makeFetch()
  seedAccount("uid-latest", { at: 1_000 })
  seedCode("uid-latest", "CODE-LATEST")
  reservedStore.write("CODE-RESERVED")

  const { method } = await makePlugin({ fetchImpl })

  // 0 / 1 = 走自动源（最新账号），不是把 "0" 当码、也不是「沿用预留」
  assert.equal(await method.ask({ invite: "0" }), null)
  assert.equal(await method.ask({ invite: "1" }), null)
  assert.deepEqual(
    fetchImpl.shareCalls().map((c) => c.path),
    ["/r/CODE-LATEST", "/r/CODE-LATEST"],
    "0 / 1 = 自动源（最新账号），不是沿用预留码",
  )

  // 手填新码 → 覆盖自动源；并回写预留（下次 0 / 1 就是它）
  assert.equal(await method.ask({ invite: "CODE-TYPED" }), null)
  assert.deepEqual(fetchImpl.shareCalls().at(-1).path, "/r/CODE-TYPED")
  assert.equal(reservedStore.read(), "CODE-TYPED", "用户手填的码要成为新的预留值")

  const flow = await authorize(method, { invite: "CODE-TYPED" })
  assert.equal(new URL(flow.url).searchParams.get("referral_state"), shareStateOf("CODE-TYPED"))
  assert.match(flow.instructions, /预留/)
  await finish(flow, "oauth-code-typed")
})

// ═══ ⑤ 采集：usage / checkin 的有界取码 ═════════════════════════════

test("usage 采集：设备已注册且没码 → 一次 /me + 一次 /code；24h 内只试一次；码按 uid 落盘", async () => {
  const account = "uid-harvest"
  // 登录时就会记下「本机见过这个账号」（firstSeenAt 只写一次）
  seedAccount(account, { at: 1_000 })
  readyInstallation(account)
  const fetchImpl = makeFetch()
  const { plugin } = await makePlugin({ fetchImpl })
  const getAuth = async () => ({ type: "oauth", access: "access-harvest", uid: account })

  await plugin.auth.usage(getAuth, { id: PROVIDER })
  const meCalls = fetchImpl.count(REFERRAL_ME_PATH, "GET")
  assert.ok(meCalls >= 1, "先只读资格")
  assert.equal(fetchImpl.count(REFERRAL_CODE_PATH, "POST"), 1, "合格才取码")
  assert.equal(sources.readCode(account)?.code, "CODE-HARVEST", "码按 uid 落盘")

  // 24h 内第二次：usage 主结果照常（命中缓存），采集不再发请求
  await plugin.auth.usage(getAuth, { id: PROVIDER })
  assert.equal(fetchImpl.count(REFERRAL_ME_PATH, "GET"), meCalls, "24h 内只试一次")
  assert.equal(fetchImpl.count(REFERRAL_CODE_PATH, "POST"), 1, "24h 内不重复取码")

  // 有码之后，off 的自动源就能用上它
  assert.equal(sources.resolve({ preferFirst: false, reservedCode: "" }).code, "CODE-HARVEST")
  assertNoForbiddenOutbound(fetchImpl)
})

test("usage 采集：设备未注册 → 零 referrals 请求（绝不 force 注册）", async () => {
  const account = "uid-unregistered"
  // 故意不写安装记录
  const fetchImpl = makeFetch()
  const { plugin } = await makePlugin({ fetchImpl })
  const getAuth = async () => ({ type: "oauth", access: "access-unregistered", uid: account })

  await plugin.auth.usage(getAuth, { id: PROVIDER })
  assert.equal(fetchImpl.referralCalls().length, 0, "设备没注册就一条 referrals 请求都不发")
  assert.equal(sources.readCode(account), null, "也不写半条码")
})

test("采集失败（/code 503）不影响 usage 主结果，也不影响签到 outcome", async () => {
  const account = "uid-harvest-fail"
  readyInstallation(account)
  const fetchImpl = makeFetch({
    [REFERRAL_CODE_PATH]: () => new Response(JSON.stringify({ error: { code: "dependency_unavailable" } }), { status: 503 }),
  })
  const { plugin } = await makePlugin({ fetchImpl })
  const getAuth = async () => ({ type: "oauth", access: "access-harvest-fail", uid: account })

  // usage：主结果照常（不抛、不是 error）
  const usage = await plugin.auth.usage(getAuth, { id: PROVIDER })
  assert.ok(usage && typeof usage === "object")
  assert.equal(usage.error, undefined, "采集失败不能污染额度主结果")
  assert.ok(Array.isArray(usage.windows))
  assert.equal(fetchImpl.count(REFERRAL_CODE_PATH, "POST"), 1, "确实尝试过一次")
  assert.equal(sources.readCode(account), null, "失败不落码")

  // checkin：主结果照常（claimed），不能因为采集失败变红
  const checkin = await plugin.auth.checkin(getAuth, { id: PROVIDER })
  assert.equal(checkin.outcome, "claimed", "采集失败不能让签到变红")
  assert.notEqual(checkin.outcome, "failed")

  assertNoForbiddenOutbound(fetchImpl)
})

test("采集：/me 没资格 → 不 POST /code（只记 reason，不伪造）", async () => {
  const account = "uid-ineligible"
  readyInstallation(account)
  const fetchImpl = makeFetch({
    [REFERRAL_ME_PATH]: () => json({ referral: { eligible_to_invite: false, eligibility_reason: "desktop_activation_required" } }),
  })
  const { plugin } = await makePlugin({ fetchImpl })
  const getAuth = async () => ({ type: "oauth", access: "access-ineligible", uid: account })

  await plugin.auth.usage(getAuth, { id: PROVIDER })
  assert.equal(fetchImpl.count(REFERRAL_ME_PATH, "GET"), 1)
  assert.equal(fetchImpl.count(REFERRAL_CODE_PATH, "POST"), 0, "没资格不许写")
  assert.equal(sources.readCode(account), null)
})

// ═══ ⑥ 换账号不串码 ═══════════════════════════════════════════════════

test("换账号不串码：首选从 A 换成 B，各自用自己的码", async () => {
  const fetchImpl = makeFetch()
  seedPreferred("uid-a")
  seedAccount("uid-a", { at: 1_000 })
  seedCode("uid-a", "CODE-A")
  seedAccount("uid-b", { at: 2_000 })
  seedCode("uid-b", "CODE-B")

  const { method } = await makePlugin({ option: onOption(), fetchImpl })

  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）

  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")

  assert.equal(await method.ask({ invite: "" }), null)
  assert.deepEqual(fetchImpl.shareCalls().map((c) => c.path), ["/r/CODE-A"])
  const flowA = await authorize(method, {})
  assert.equal(new URL(flowA.url).searchParams.get("referral_state"), shareStateOf("CODE-A"))
  await finish(flowA, "code-a")

  // 账号页把 B 设成首选
  seedPreferred("uid-b")
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null)
  assert.deepEqual(fetchImpl.shareCalls().map((c) => c.path), ["/r/CODE-A", "/r/CODE-B"])
  const flowB = await authorize(method, {})
  assert.equal(new URL(flowB.url).searchParams.get("referral_state"), shareStateOf("CODE-B"))
  await finish(flowB, "code-b")

  // 两个 uid 各自的码都还在，互不覆盖
  assert.equal(sources.readCode("uid-a")?.code, "CODE-A")
  assert.equal(sources.readCode("uid-b")?.code, "CODE-B")
})

test("换账号判死：最新账号 eligible=false → 自动源回退到上一个账号", async () => {
  seedAccount("uid-a", { at: 1_000 })
  seedCode("uid-a", "CODE-A")
  seedAccount("uid-b", { at: 2_000 })
  seedCode("uid-b", "CODE-B")

  assert.equal(sources.resolve({ preferFirst: false, reservedCode: "" }).code, "CODE-B")
  sources.markEligibility({ uid: "uid-b", eligible: false, reason: "ineligible" })
  assert.equal(sources.resolve({ preferFirst: false, reservedCode: "" }).code, "CODE-A", "死号不参与，但码还在")
  // 首选模式也看资格
  assert.equal(sources.resolve({ preferFirst: true, preferredUid: "uid-b", reservedCode: "" }).kind, "none")
  assert.equal(sources.resolve({ preferFirst: true, preferredUid: "uid-a", reservedCode: "" }).code, "CODE-A")
})

// ═══ ⑦ H1：真实宿主只会传 `undefined`（prompts 非空也照样） ═══════════════
//
// 宿主契约：`m.authorize(m.prompts?.length ? inputs ?? {} : undefined, …)`。
// 也就是说**只要** `prompts` 为空，`ask()` 就永远不会被问、`inputs` 永远是 `undefined`。
// 这条用例锁住「手填码」和「自动源」在**那条真实路径**上都必须生效。

test("H1：ask 记下的源在 authorize(undefined) 上生效（手填 / 自动各一次）", async () => {
  const fetchImpl = makeFetch()

  // ① 手填码：ask 记下的是「用户填的码」，authorize 拿到 undefined 也必须用它
  {
    const { method, login } = await makePlugin({ fetchImpl })
    assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码")
    assert.equal(fetchImpl.shareCalls().length, 0, "问问题本身零出站")
    assert.equal(await method.ask({ invite: "CODE-MANUAL" }), null, "回答后没有下一个问题")
    assert.deepEqual(
      fetchImpl.shareCalls().map((c) => c.path),
      ["/r/CODE-MANUAL"],
      "回答后才抓一次分享页",
    )

    const flow = await authorize(method, undefined) // ← 宿主真实传法
    assert.equal(
      new URL(flow.url).searchParams.get("referral_state"),
      shareStateOf("CODE-MANUAL"),
      "authorize(undefined) 也必须带本次手填码的 referral_state",
    )
    await finish(flow, "h1-manual")
    assert.equal(login.launches[0].closed, 1)
  }

  // ② 自动源：留空 = 走最新账号，authorize(undefined) 同样生效
  {
    seedAccount("uid-latest", { at: 5_000 })
    seedCode("uid-latest", "CODE-LATEST")
    const { method, login } = await makePlugin({ fetchImpl })

    assert.equal((await method.ask({}))?.key, "invite")
    assert.equal(await method.ask({ invite: "" }), null, "留空 = 自动源")
    assert.deepEqual(fetchImpl.shareCalls().at(-1).path, "/r/CODE-LATEST")

    const flow = await authorize(method, undefined)
    assert.equal(
      new URL(flow.url).searchParams.get("referral_state"),
      shareStateOf("CODE-LATEST"),
      "authorize(undefined) 也必须带自动源的 referral_state",
    )
    await finish(flow, "h1-auto")
    assert.equal(login.launches[0].closed, 1)
  }
})
