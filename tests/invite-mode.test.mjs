// tests/invite-mode.test.mjs —— invite_mode 开关的接线（off / on / 切换 / 换码 / 清理）
//
// 锁的是「邀请模式」这一层的**行为**（不是源码文本），语义以用户最终确认为准：
//
//   off（默认）= 自动：用「最新注册账号」的邀请链接；最新没码就回退上一个可用账号；
//                一个都没有 → 用户预留码；再没有 → 不带邀请、照常登录。
//   on         = 首选：只用 magpie 账号页「Make first」那个账号的码；
//                首选没码 / 不可用 → **只**回退预留码，绝不静默换别的账号。
//
// 具体判据：
//   · auth.options 里只有一个 provider 级开关：placement 是字符串 "top"，**不是** top: true；
//     文案必须说清新语义（关闭=最新账号自动 / 开启=magpie 首选账号）
//   · 自动源**不弹问题**：prompts 恒 []、ask 恒返回 null（用户不必填码）；关 / 开 / 切换都实时读取
//   · ask 是唯一出站点：有码才抓**一次** /r/<code>；authorize 零出站，只读本次进程 Map
//   · 用户手填合法码优先于自动源（off 也一样）；填 0 / 1 / 留空 = 沿用预留
//   · 分享页失败 / 非法码 / 空码：回退裸授权 URL，说明 reason 分类，文案不含 code/state 原值
//   · 换码不沿用旧 state；不同邀请码各自记录、互不覆盖
//   · 登录路径永不碰 referrals 写面（bind / code / me / relations）
//   · 每个 authorize 结束后浏览器与 loopback 都必须关掉（否则测试进程会吊到 300s 超时）
//
// 全程离线：注入假 fetch / 假 isolatedLogin，HOME 重定向到临时目录。

import { test, after, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ⚠ 先重定向 HOME 再动态 import —— 邀请策略写 ~/.cache/magpie/phanthycode-invite*.json，
//   首选账号读 ~/.config/magpie/logins.json + plugin-auth.json。
const home = mkdtempSync(join(tmpdir(), "pw-invite-mode-"))
process.env.HOME = home
process.env.USERPROFILE = home

const { PhanthyCodeAuthPlugin } = await import("../index.mjs")
const { BASE, PROVIDER } = await import("../src/context.mjs")
const { TOKEN_PATH } = await import("../src/oauth.mjs")
const { PROFILE_PATH } = await import("../src/phanthy-api.mjs")
const { createInviteStore } = await import("../src/invite.mjs")
const { createInviteSourceStore } = await import("../src/invite-source.mjs")

after(() => rmSync(home, { recursive: true, force: true }))

const OPTION_KEY = "invite_mode"

// ── 假件（不联网 / 不弹浏览器）────────────────────────────────────────

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** 分享页 HTML（与真实形状一致：`&` 被写成 `&amp;`） */
function shareHtml(referralState) {
  return `<a href="/login?next=%2Foauth%2Fauthorize&amp;referral_state=${encodeURIComponent(referralState)}">登录</a>`
}

/**
 * 记录调用的假请求器。
 * @param {{share?: Function|object, token?: Function, profile?: Function}} [o]
 */
function makeFetch({ share = () => ({ status: 200, body: shareHtml("rs1.state.default") }), token, profile } = {}) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = String(input)
    const method = String(init.method ?? "GET").toUpperCase()
    calls.push({ url, method, init })
    const path = new URL(url).pathname

    if (path.startsWith("/r/")) {
      const r = typeof share === "function" ? share(path, url) : share
      return new Response(r?.body ?? "", { status: r?.status ?? 200, headers: r?.headers })
    }
    if (path === TOKEN_PATH) {
      return token
        ? token()
        : json({ access_token: "access-invite-mode", refresh_token: "refresh-invite-mode", expires_in: 1800 })
    }
    if (path === PROFILE_PATH) {
      return profile
        ? profile()
        : json({ account: { uuid: "scope-invite-mode", display_name: "+86 178****4697" } })
    }
    return json({})
  }
  fetchImpl.calls = calls
  /** 分享页（/r/<code>）请求 */
  fetchImpl.shareCalls = () => calls.filter((c) => new URL(c.url).pathname.startsWith("/r/"))
  fetchImpl.paths = () => calls.map((c) => new URL(c.url).pathname)
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

/**
 * 造一个插件实例。
 * `option` 省略 = 没有 magpie 上下文（旧宿主 / 测试）；传函数 = 实时读开关。
 */
async function makePlugin({ option, fetchImpl, isolatedLogin } = {}) {
  const ctx = option === undefined ? {} : { magpie: { option } }
  const login = isolatedLogin ?? fakeIsolatedLogin()
  const fetch = fetchImpl ?? makeFetch()
  const plugin = await PhanthyCodeAuthPlugin(ctx, { fetch, isolatedLogin: login })
  return { plugin, method: plugin.auth.methods[0], login, fetch }
}

/** 开关打开（provider / key 都要对上） */
const onOption = () => (provider, key) => provider === PROVIDER && key === OPTION_KEY

// ── loopback 兜底清理 ────────────────────────────────────────────────
//
// 断言失败时往往还没走到 `callback()`，那个 loopback Server 会一直开着，
// 整个测试进程要等到 300s 超时才退（review 里实测过 [still running after 120000ms]）。
// 所以**每次 authorize 都登记**，afterEach 把漏掉的一律关掉。

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

// ── 策略文件 ─────────────────────────────────────────────────────────

const CACHE_DIR = join(home, ".cache", "magpie")
const CONFIG_DIR = join(home, ".config", "magpie")

function storeFile() {
  return join(CACHE_DIR, "phanthycode-invite.json")
}

/**
 * 清掉**所有**邀请状态：用户预留码 + 账号索引 + 每账号的码 + magpie 首选账号文件。
 *
 * ⚠ 不能只删 `-invite.json`：登录回调会 `noteAccount` 写账号索引，账号索引里的
 *   「最新账号」会跨用例泄漏 —— 后面「没有源」的用例会突然抓到一个别的用例留下的码。
 */
function resetStore() {
  rmSync(storeFile(), { force: true })
  try {
    for (const name of readdirSync(CACHE_DIR)) {
      if (/^phanthycode-invite-(accounts|code-.*)\.json$/.test(name)) rmSync(join(CACHE_DIR, name), { force: true })
    }
  } catch {
    // 目录还不存在：没有可清的
  }
  rmSync(join(CONFIG_DIR, "logins.json"), { force: true })
  rmSync(join(CONFIG_DIR, "plugin-auth.json"), { force: true })
}

function readPolicy() {
  return JSON.parse(readFileSync(storeFile(), "utf8"))
}

// ── 邀请源夹具（账号索引 / 每账号的码 / magpie 首选账号）──────────────

const sources = createInviteSourceStore(PROVIDER)

function seedAccount(uid, { at } = {}) {
  return sources.noteAccount({
    uid,
    accountScope: `scope-${uid}`,
    accountId: `name-${uid}`,
    ...(at === undefined ? {} : { at }),
  })
}

function seedCode(uid, code) {
  return sources.saveCode({ uid, code, shareUrl: `${BASE}/r/${code}`, slot: 1 })
}

/** magpie 账号页「Make first」：logins.json 的 first 行 + plugin-auth.json 的稳定 uid */
function seedPreferred(uid, { home: homeId = "phanthycode#preferred" } = {}) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(
    join(CONFIG_DIR, "logins.json"),
    JSON.stringify([{ id: "row-1", agent: `plugin:${PROVIDER}`, user: "u", home: homeId, first: true, order: 1 }]),
  )
  writeFileSync(
    join(CONFIG_DIR, "plugin-auth.json"),
    JSON.stringify({ [homeId]: { metadata: { userId: uid, accountScope: "scope-preferred" }, accountId: "首选账号" } }),
  )
}

// ── 进程清理断言 ─────────────────────────────────────────────────────

/** 当前进程里还活着的 loopback HTTP Server（只看 127.0.0.1） */
function loopbackServers() {
  const handles = typeof process._getActiveHandles === "function" ? process._getActiveHandles() : []
  return handles.filter((handle) => {
    if (handle?.constructor?.name !== "Server") return false
    try {
      return handle.address?.()?.address === "127.0.0.1"
    } catch {
      return false
    }
  })
}

/** close 之后端口释放是异步的：给一个 tick 再断言 */
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

// ═══ ① 声明形状 ═══════════════════════════════════════════════════════

test("auth.options 只增加一个 provider 级开关：placement 是字符串 top，默认关闭", async () => {
  const { plugin } = await makePlugin()

  const options = plugin.auth.options
  assert.ok(Array.isArray(options), "auth.options 必须是数组")
  assert.equal(options.length, 1, "只增加一个开关（不新增登录方式）")

  const [o] = options
  assert.equal(o.key, OPTION_KEY)

  // 契约硬约束
  assert.match(o.key, /^[a-z0-9_-]{1,40}$/)
  assert.ok(o.label.trim().length > 0 && o.label.length <= 60, "label 必填且 ≤ 60")
  assert.ok(o.description.length <= 300, "description ≤ 300")
  assert.equal(o.default, false, "默认必须关闭（不改变现有用户行为）")

  // 新语义文案：关 = 自动用最新注册账号的邀请链接；开 = magpie 首选账号（Make first）
  assert.match(o.description, /最新|最近/, "关闭时自动使用最新注册账号的邀请链接")
  assert.match(o.description, /首选|Make first/i, "开启时使用 magpie 账号页的首选账号")
  assert.match(o.description, /仅新注册账号/, "只对新注册账号生效")
  assert.equal(o.labels.zh, o.label)
  assert.equal(o.descriptions.zh, o.description)

  // 关键纠偏：placement 是字符串 "top"，不是 top: true
  assert.equal("top" in o, false, "不能写 top: true —— magpie 的 optionsOf 完全不读 o.top")
  assert.equal(o.placement, "top")

  // 归一化与 magpie 的 optionsOf 完全一致
  const norm = (x) => (x.placement === "top" ? "top" : undefined)
  assert.equal(norm(o), "top")
  assert.equal(norm({ placement: "bottom" }), undefined)
  assert.equal(norm({ placement: true }), undefined)
  assert.equal(norm({}), undefined)

  // 不新增登录方式
  assert.deepEqual(plugin.auth.methods.map((m) => m.type), ["oauth", "api"])
})

// ═══ ② 默认 / 旧宿主：off ════════════════════════════════════════════

test("off（无 magpie 上下文）：用户手填合法码 → ask 抓且仅抓一次 /r/<码>，authorize 包装该码", async () => {
  resetStore()
  const state = "rs1.invite-mode.off-typed"
  const fetchImpl = makeFetch({ share: () => ({ status: 200, body: shareHtml(state) }) })
  const { method, login } = await makePlugin({ fetchImpl })

  // 自动源不弹问题：prompts 恒空、ask 恒返回 null（用户不必填码）
  assert.equal(method.prompts.length, 1, "自动源不弹邀请码问题（不能打断加号流程）")
  assert.equal(method.prompts[0]?.key, "invite", "邀请码问题可留空 = 自动源")

  // 用户手填合法码：ask 负责唯一一次出站，然后返回 null
  assert.equal(await method.ask({ invite: "USERCODE-OFF1" }), null, "问完就返回 null")
  assert.equal(fetchImpl.shareCalls().length, 1, "手填码 → 抓且仅抓一次分享页")
  assert.equal(new URL(fetchImpl.shareCalls()[0].url).pathname, "/r/USERCODE-OFF1")
  assert.equal(fetchImpl.shareCalls()[0].method, "GET", "分享页只能是匿名 GET")
  assert.equal(fetchImpl.shareCalls()[0].init.headers.authorization, undefined, "分享页不带 Bearer")
  assert.equal(fetchImpl.shareCalls()[0].init.redirect, "manual")

  // authorize 零出站：只读本次进程 Map，把授权 URL 包进 /login
  const baseline = loopbackServers()
  const flow = await authorize(method, { invite: "USERCODE-OFF1" })
  assert.equal(fetchImpl.shareCalls().length, 1, "authorize 里绝不能再抓分享页（HOOKS 铁律 2）")

  const url = new URL(flow.url)
  assert.equal(url.pathname, "/login", "手填码要包进官方登录页")
  assert.equal(url.searchParams.get("referral_state"), state)
  assert.deepEqual([...url.searchParams.keys()].sort(), ["next", "referral_state"])
  const nextUrl = new URL(url.searchParams.get("next"))
  assert.equal(nextUrl.origin, BASE)
  assert.equal(nextUrl.pathname, "/oauth/authorize")
  assert.ok(nextUrl.searchParams.get("state"), "next 里必须带 state")
  // 单层编码：next 是百分号编码的 URL，不是二次编码
  assert.match(flow.url, /[?&]next=https%3A%2F%2F/)
  assert.doesNotMatch(flow.url, /next=https%253A/)

  // 文案：本次来源是「预留」（用户手填），只对新号有效；不含 code / state 原值
  assert.match(flow.instructions, /预留/, "本次邀请源是预留码（用户手填）")
  assert.match(flow.instructions, /仅新注册账号有效/)
  assert.match(flow.instructions, /独立登录窗口|不带你日常浏览器/, "原有的隔离浏览器说明必须保留")
  assert.doesNotMatch(flow.instructions, /USERCODE-OFF1/, "文案不得含邀请码原值")
  assert.doesNotMatch(flow.instructions, /rs1\.invite-mode/, "文案不得含 referral_state 原值")

  const result = await finish(flow, "oauth-code-off")
  assert.equal(result.type, "success", result.error)
  assert.equal(login.launches.length, 1)
  assert.equal(login.launches[0].closed, 1, "callback 结束必须关掉本次隔离浏览器")

  await settle()
  assert.equal(loopbackServers().length, baseline.length, "loopback 必须关闭，不能吊住进程")
})

test("off + 未填码 + 无账号源：裸授权 URL 且零 /r/ 请求", async () => {
  resetStore()
  const fetchImpl = makeFetch()
  const { method, login } = await makePlugin({ fetchImpl })

  assert.equal(method.prompts.length, 1, "没有源也不弹问题（照常登录）")

  assert.equal(method.prompts[0]?.key, "invite", "邀请码问题可留空 = 自动源")
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null, "没有下一个问题")
  assert.equal(fetchImpl.shareCalls().length, 0, "没有源就零分享页请求")

  const baseline = loopbackServers()
  const flow = await authorize(method, {})
  const url = new URL(flow.url)
  assert.equal(`${url.origin}${url.pathname}`, `${BASE}/oauth/authorize`, "没有源 = 裸授权 URL")
  assert.equal(url.searchParams.get("next"), null, "没有源不能包 /login")
  assert.equal(url.searchParams.get("referral_state"), null)
  assert.match(flow.instructions, /邀请链接未准备（/, "没有源要说清原因")
  assert.match(flow.instructions, /已按普通登录继续/)
  assert.doesNotMatch(flow.instructions, /rs1\./, "文案不得含 state 原值")
  assert.equal(fetchImpl.shareCalls().length, 0, "authorize 零出站")

  const result = await finish(flow, "oauth-code-none")
  assert.equal(result.type, "success", "没有源不能阻塞登录")
  assert.equal(login.launches.length, 1)
  assert.equal(login.launches[0].closed, 1)

  await settle()
  assert.equal(loopbackServers().length, baseline.length, "loopback 必须关闭")
})

test("无 magpie 上下文安全：{} / null / 空 option / 非布尔值都按 off", async () => {
  const contexts = [
    {},
    null,
    { magpie: {} },
    { magpie: { option: null } },
    { magpie: { option: () => "yes" } },
    { magpie: { option: () => 1 } },
    { magpie: { option: (provider, key) => (key === OPTION_KEY ? 1 : false) } },
  ]
  for (const ctx of contexts) {
    const fetchImpl = makeFetch()
    const plugin = await PhanthyCodeAuthPlugin(ctx, {
      fetch: fetchImpl,
      isolatedLogin: fakeIsolatedLogin(),
    })
    const method = plugin.auth.methods[0]
    // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
    assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
    assert.equal(await method.ask({ invite: "" }), null, `ctx=${JSON.stringify(ctx)} 必须按 off`)
    assert.equal(method.prompts.length, 1)
    assert.equal(method.prompts[0]?.key, "invite", "邀请码问题可留空 = 自动源")
  }
})

// L-4：宿主 option 抛错 / 不是函数时，不允许连累整条登录方式列表

test("宿主 option 抛错 / 不是函数：按 off 处理，prompts / ask / authorize 都不抛", async () => {
  const contexts = [
    // option 本身抛错（宿主内部异常）
    {
      magpie: {
        option: () => {
          throw new Error("host option boom")
        },
      },
    },
    // option 存在但不是函数：`?.()` 会 TypeError
    { magpie: { option: "not-a-function" } },
  ]

  for (const ctx of contexts) {
    resetStore()
    const fetchImpl = makeFetch()
    const login = fakeIsolatedLogin()
    const plugin = await PhanthyCodeAuthPlugin(ctx, { fetch: fetchImpl, isolatedLogin: login })
    const method = plugin.auth.methods[0]

    // prompts 是 getter：抛错会连累整条登录方式列表（宿主拿不到 methods 就登录不了）
    assert.equal(method.prompts.length, 1, "option 抛错时按 off：不显示邀请码问题")
    assert.equal(method.prompts[0]?.key, "invite", "邀请码问题可留空 = 自动源")
    // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
    assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
    assert.equal(await method.ask({ invite: "" }), null, "option 抛错时 ask 立刻返回 null")
    assert.equal(await method.ask({ invite: "CODE-HOST-THROW" }), null)

    const flow = await authorize(method, { invite: "CODE-HOST-THROW" })
    assert.equal(new URL(flow.url).searchParams.get("next"), null, "off ⇒ 裸授权 URL")
    const result = await finish(flow, "code-host-throw")
    assert.equal(result.type, "success", result.error)
    assert.equal(fetchImpl.shareCalls().length, 0, "off ⇒ 分享页零请求")
    assert.equal(login.launches[0].closed, 1)
  }
})

// ═══ ③ 开启：ask 抓一次，authorize 包 /login ═════════════════════════

test("on：自动源不弹问题；首选账号有码 → ask 只抓一次 /r/<首选码>，authorize 零出站并包装", async () => {
  resetStore()
  seedPreferred("uid-preferred")
  seedAccount("uid-preferred", { at: 1_000 })
  seedCode("uid-preferred", "CODE-PREFERRED")
  // 另一个更早的账号也有码：on 只能认首选，不许拿最新那个
  seedAccount("uid-latest", { at: 2_000 })
  seedCode("uid-latest", "CODE-LATEST")

  const state = "rs1.invite-mode.preferred"
  const fetchImpl = makeFetch({ share: () => ({ status: 200, body: shareHtml(state) }) })
  const { method, login } = await makePlugin({ option: onOption(), fetchImpl })

  // 自动源不弹问题（HOOKS 陷阱 5：无提问返回 null，不能让加号流程卡在输入框）
  assert.equal(method.prompts.length, 1, "自动源不弹问题")
  assert.equal(method.prompts[0]?.key, "invite", "邀请码问题可留空 = 自动源")
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null, "没有下一个问题")
  assert.deepEqual(
    fetchImpl.shareCalls().map((c) => new URL(c.url).pathname),
    ["/r/CODE-PREFERRED"],
    "on = 只用 magpie 首选账号的码（不是最新那个）",
  )

  // authorize 零出站：出站只发生在 ask
  const baseline = loopbackServers()
  const before = fetchImpl.calls.length
  const flow = await authorize(method, {})
  assert.equal(fetchImpl.calls.length, before, "authorize 零出站（HOOKS 铁律 2）")

  const url = new URL(flow.url)
  assert.equal(url.pathname, "/login", "必须包进官方登录页")
  assert.equal(url.searchParams.get("referral_state"), state)
  assert.deepEqual([...url.searchParams.keys()].sort(), ["next", "referral_state"])

  const next = url.searchParams.get("next")
  assert.ok(next.startsWith(`${BASE}/oauth/authorize?`), "next 必须是完整授权 URL")
  // 单层编码：next 是百分号编码的 URL，不是二次编码
  assert.match(flow.url, /[?&]next=https%3A%2F%2F/)
  assert.doesNotMatch(flow.url, /next=https%253A/)
  const nextUrl = new URL(next)
  assert.ok(nextUrl.searchParams.get("state"), "next 里必须带 state")
  assert.ok(nextUrl.searchParams.get("code_challenge"), "next 里必须带 PKCE challenge")
  assert.match(nextUrl.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)

  // 文案：说明本次来源是「首选账号」，且只对新注册账号有效；不含 code / state 原值
  assert.match(flow.instructions, /首选/, "本次邀请源是 magpie 首选账号")
  assert.match(flow.instructions, /邀请链接已准备，仅新注册账号有效/)
  assert.match(flow.instructions, /独立登录窗口|不带你日常浏览器/, "原有的隔离浏览器说明必须保留")
  assert.doesNotMatch(flow.instructions, /CODE-PREFERRED/, "文案不得含邀请码原值")
  assert.doesNotMatch(flow.instructions, /rs1\.invite-mode/, "文案不得含 referral_state 原值")

  const result = await finish(flow, "oauth-code-on")
  assert.equal(result.type, "success", result.error)

  // 换票用的 state / redirect_uri 必须与 next 里的一致 —— 证明包进去的就是这次授权 URL
  const tokenCall = fetchImpl.calls.find((c) => new URL(c.url).pathname === TOKEN_PATH)
  assert.ok(tokenCall, "必须换票")
  const form = new URLSearchParams(String(tokenCall.init.body))
  assert.equal(form.get("state"), nextUrl.searchParams.get("state"))
  assert.equal(form.get("redirect_uri"), nextUrl.searchParams.get("redirect_uri"))

  assert.equal(login.launches.length, 1)
  assert.equal(login.launches[0].closed, 1, "假 launch.close 必须被调用")
  await settle()
  assert.equal(loopbackServers().length, baseline.length, "loopback 必须关闭")
})

// ═══ ④ 失败回退 + 脱敏 ═══════════════════════════════════════════════

test("分享页失败：回退裸授权 URL，说明 reason 分类，且文案不含 code / state 原值", async () => {
  const secretCode = "credential-looking-CODE-9"
  const secretState = `rs1.credential-looking-${"A".repeat(40)}`

  const cases = [
    // [分享页响应, 期望 reason]
    [{ status: 500, body: "boom" }, "http_error"],
    [{ status: 302, body: "", headers: { location: `${BASE}/login` } }, "redirect"],
    [{ status: 200, body: "<html>没有链接</html>" }, "no_state"],
    // 有链接但 value 不是合法的 rs1.*（前缀不对）→ 同样 no_state，且不能回显原值
    [{ status: 200, body: `<a href="/login?referral_state=${secretState.replace("rs1.", "rs2.")}">x</a>` }, "no_state"],
  ]

  for (const [response, reason] of cases) {
    resetStore()
    const fetchImpl = makeFetch({ share: () => response })
    const { method, login } = await makePlugin({ option: onOption(), fetchImpl })

    assert.equal(await method.ask({ invite: secretCode }), null)
    assert.equal(fetchImpl.shareCalls().length, 1, "回答邀请码时抓一次分享页")

    const flow = await authorize(method, { invite: secretCode })
    assert.equal(fetchImpl.shareCalls().length, 1, "authorize 不许再抓")

    const result = await finish(flow, `oauth-code-${reason}`)
    assert.equal(result.type, "success", "分享页失败不能阻塞登录")
    assert.equal(login.launches[0].closed, 1)

    const url = new URL(flow.url)
    assert.equal(url.searchParams.get("next"), null, `reason=${reason} 必须回退裸授权 URL`)
    assert.equal(url.searchParams.get("referral_state"), null)
    assert.match(flow.instructions, new RegExp(`邀请链接未准备（${reason}`), `reason=${reason} 要分类给出`)
    assert.match(flow.instructions, /已按普通登录继续/)
    // 脱敏：文案里不得出现邀请码或 state 原值
    assert.doesNotMatch(flow.instructions, new RegExp(secretCode))
    assert.doesNotMatch(flow.instructions, /credential-looking/)
  }

  // 网络错误
  resetStore()
  {
    const fetchImpl = makeFetch({
      share: () => {
        throw new Error("socket hang up")
      },
    })
    const { method, login } = await makePlugin({ option: onOption(), fetchImpl })
    await method.ask({ invite: secretCode })
    const flow = await authorize(method, { invite: secretCode })
    await finish(flow, "oauth-code-network")
    assert.match(flow.instructions, /邀请链接未准备（network/)
    assert.equal(login.launches[0].closed, 1)
  }

  // 白名单外的码：零请求 + invalid_code
  resetStore()
  {
    const fetchImpl = makeFetch()
    const { method, login } = await makePlugin({ option: onOption(), fetchImpl })
    await method.ask({ invite: "../evil" })
    assert.equal(fetchImpl.shareCalls().length, 0, "非法码零请求")
    const flow = await authorize(method, { invite: "../evil" })
    await finish(flow, "oauth-code-illegal")
    assert.match(flow.instructions, /邀请链接未准备（invalid_code/)
    assert.equal(login.launches[0].closed, 1)
  }
})

// ⚠ L-7：这条只覆盖**空策略文件**的情形（下面先 resetStore）。store 非空时
// 「不填邀请码 = 不带邀请」由下一条 M-1a 用例负责，标题不能再暗示它覆盖全部情况。

test("on + 空策略文件、没填邀请码：不带邀请、零请求，说明 no_code", async () => {
  resetStore()
  const fetchImpl = makeFetch()
  const { method, login } = await makePlugin({ option: onOption(), fetchImpl })

  assert.equal(await method.ask({ invite: "   " }), null, "空码直接结束")
  assert.equal(fetchImpl.shareCalls().length, 0, "空码零请求")

  const flow = await authorize(method, { invite: "" })
  const result = await finish(flow, "oauth-code-empty")
  assert.equal(result.type, "success", result.error)

  assert.equal(new URL(flow.url).searchParams.get("referral_state"), null)
  // on 模式没配「首选」：没有可用源，如实说明分类（不编造、不静默换人）
  assert.match(flow.instructions, /邀请链接未准备（preferred_missing：没有首选账号（请在 magpie 账号页用 Make first 指定）），已按普通登录继续/)
  assert.doesNotMatch(flow.instructions, /rs1\./, "文案不得含 state 原值")
  assert.equal(login.launches[0].closed, 1)
})

// ═══ ④-2 M-1a：没经过 ask 的 authorize 绝不复用磁盘上的旧码 / 旧 state ═══
//
// 用户没在**本次**流程里表达邀请意图（`authorize({})`），或者留空（`invite: ""`）
// 但本次没换到 state 时，只允许裸授权 URL。磁盘上上一次的码 / `rs1.…` 一律不参与：
//  · `rs1.…` 是按链接即时签发、可能过期的状态令牌，旧值会**静默失效**；
//  · 自动套旧码等于替「另一个新号」建立邀请关系，用户根本没同意。

test("store 里有旧码 / 旧 state：authorize({}) 与 authorize({invite:''}) 仍是裸 URL、零分享页请求", async () => {
  resetStore()
  const store = createInviteStore(PROVIDER)
  store.write("CODE-STORED", {
    source: "chosen",
    extra: { referralState: "rs1.stored.OLD", referralStateAt: 1 },
  })
  // 前置：磁盘上确实有旧码 + 旧 state
  assert.equal(store.read(), "CODE-STORED")
  assert.equal(store.readExtra("referralState"), "rs1.stored.OLD")

  const fetchImpl = makeFetch({ share: () => ({ status: 200, body: shareHtml("rs1.fresh.NEW") }) })
  const { method, login } = await makePlugin({ option: onOption(), fetchImpl })

  // ① 完全没经 ask 的 authorize({})：不许用磁盘上的码 / state 包装
  const flowNoInput = await authorize(method, {})
  await finish(flowNoInput, "code-no-input")
  assert.equal(new URL(flowNoInput.url).searchParams.get("next"), null, "authorize({}) 不许包 /login")
  assert.equal(
    new URL(flowNoInput.url).searchParams.get("referral_state"),
    null,
    "authorize({}) 绝不能拿磁盘上旧的 referral_state",
  )
  assert.doesNotMatch(flowNoInput.instructions, /rs1\./, "文案不得回显 state 原值")
  assert.doesNotMatch(flowNoInput.instructions, /CODE-STORED/, "文案不得回显邀请码原值")
  assert.equal(fetchImpl.shareCalls().length, 0, "authorize 本身零请求")

  // ② 有这个 key 但留空：仍按 resolveInvite 沿用当前码，可 state 只认**本次进程的 Map**（此时为空）
  const flowEmpty = await authorize(method, { invite: "" })
  await finish(flowEmpty, "code-empty-input")
  assert.equal(
    new URL(flowEmpty.url).searchParams.get("next"),
    null,
    "本次没换到 state 就不许包装 —— 哪怕磁盘上有旧 state",
  )
  assert.equal(new URL(flowEmpty.url).searchParams.get("referral_state"), null)
  assert.equal(fetchImpl.shareCalls().length, 0, "authorize 绝不去抓分享页")

  // ③ 本次真的经 ask 解析过（留空 = 沿用当前码）之后，才允许用**这一次**换到的 state
  assert.equal(await method.ask({ invite: "" }), null)
  assert.deepEqual(
    fetchImpl.shareCalls().map((c) => new URL(c.url).pathname),
    ["/r/CODE-STORED"],
    "留空沿用当前码，且只抓一次分享页",
  )
  const flowFresh = await authorize(method, { invite: "" })
  assert.equal(new URL(flowFresh.url).searchParams.get("referral_state"), "rs1.fresh.NEW", "用本次 ask 换到的 state")
  assert.match(flowFresh.instructions, /邀请链接已准备/)
  await finish(flowFresh, "code-fresh")

  assert.deepEqual(login.launches.map((l) => l.closed), [1, 1, 1], "三条流程的浏览器都要关")
})

// ═══ ④-3 M-1b：同码再问一次失败，必须**清空**磁盘 state（不是继承）══════

test("同码第二次 ask 失败（network）：磁盘 state 清空，换进程后 authorize 不再邀请", async () => {
  resetStore()
  let fail = false
  const fetchImpl = makeFetch({
    share: () => {
      if (fail) throw new Error("socket hang up")
      return { status: 200, body: shareHtml("rs1.fresh.1") }
    },
  })
  const { method, login } = await makePlugin({ option: onOption(), fetchImpl })

  // 第一次 ask：成功，state 落盘
  assert.equal(await method.ask({ invite: "CODE-SAME" }), null)
  assert.equal(readPolicy().referralState, "rs1.fresh.1")
  assert.ok(Number(readPolicy().referralStateAt) > 0, "成功时要记下取 state 的时间")

  // 第二次 ask（同一个码）失败：本次显式给了空串 ⇒ 必须清空，而不是继承上一次的 state
  fail = true
  assert.equal(await method.ask({ invite: "CODE-SAME" }), null)
  assert.equal(fetchImpl.shareCalls().length, 2, "两次 ask 各抓一次分享页")

  // 同一个进程里：本次 ask 的失败原因可见，但仍不许邀请
  const flowSame = await authorize(method, { invite: "CODE-SAME" })
  assert.equal(new URL(flowSame.url).searchParams.get("referral_state"), null, "本次没换到 state ⇒ 不许包装")
  assert.match(flowSame.instructions, /邀请链接未准备（network/)
  await finish(flowSame, "code-same-fail-same-process")

  // 换一个进程（新实例 = Map 为空）用同一个码 authorize：磁盘上已经没有 state ⇒ 不许邀请
  const second = await makePlugin({ option: onOption(), fetchImpl })
  const flow = await authorize(second.method, { invite: "CODE-SAME" })
  assert.equal(
    new URL(flow.url).searchParams.get("referral_state"),
    null,
    "磁盘 state 已清空 ⇒ 不能拿旧的 rs1 去配同一个码（那是静默失效的来源）",
  )
  assert.equal(new URL(flow.url).searchParams.get("next"), null)
  assert.match(flow.instructions, /邀请链接未准备（no_state/, "新进程里没有任何 state ⇒ 说明缺 state")
  const result = await finish(flow, "code-same-fail")
  assert.equal(result.type, "success", "state 缺失不能阻塞登录")
  await settle()

  const policy = readPolicy()
  assert.equal(policy.code, "CODE-SAME", "码本身仍是这个码")
  assert.equal(policy.referralState ?? "", "", "本次显式写空串 = 清空该 key（同码也不能继承旧 state）")
  assert.equal(policy.referralStateAt ?? "", "", "referralStateAt 要一起清空")
  assert.deepEqual(login.launches.map((l) => l.closed), [1], "第一个实例的浏览器要关")
  assert.deepEqual(second.login.launches.map((l) => l.closed), [1], "第二个实例的浏览器要关")
})

// ═══ ⑤ 实时读取：切换开关不用重建工厂 ═════════════════════════════════

test("开关实时读取：同一个工厂实例上切换立即生效，不用重建", async () => {
  resetStore()
  // 首选账号 = P（有自己的码）；另有更早的 L 也有码 —— off 取最新（L），on 取首选（P）
  seedPreferred("uid-preferred")
  seedAccount("uid-preferred", { at: 1_000 })
  seedCode("uid-preferred", "CODE-PREFERRED")
  seedAccount("uid-latest", { at: 2_000 })
  seedCode("uid-latest", "CODE-LATEST")

  const states = {
    "/r/CODE-PREFERRED": "rs1.toggle.preferred",
    "/r/CODE-LATEST": "rs1.toggle.latest",
  }
  let on = false
  const fetchImpl = makeFetch({ share: (path) => ({ status: 200, body: shareHtml(states[path] ?? "rs1.toggle.other") }) })
  const { method, login } = await makePlugin({ option: () => on, fetchImpl })

  // off：自动源 = 最新注册账号
  assert.equal(method.prompts.length, 1, "自动源不弹问题")
  assert.equal(method.prompts[0]?.key, "invite", "邀请码问题可留空 = 自动源")
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null)
  assert.deepEqual(fetchImpl.shareCalls().map((c) => new URL(c.url).pathname), ["/r/CODE-LATEST"], "off = 最新账号")

  // 拨到 on：同一个 method 立刻改用首选账号（不重建工厂）
  on = true
  assert.equal(method.prompts.length, 1, "getter 实时读开关：仍然不弹问题（自动源）")
  assert.equal(method.prompts[0]?.key, "invite", "邀请码问题可留空 = 自动源")
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null)
  assert.deepEqual(
    fetchImpl.shareCalls().map((c) => new URL(c.url).pathname),
    ["/r/CODE-LATEST", "/r/CODE-PREFERRED"],
    "on = 首选账号",
  )

  const flowOn = await authorize(method, {})
  assert.equal(new URL(flowOn.url).searchParams.get("referral_state"), states["/r/CODE-PREFERRED"])
  assert.match(flowOn.instructions, /首选/)
  await finish(flowOn, "code-toggle-on")

  // 再拨回 off：立刻回到最新账号
  on = false
  assert.equal(method.prompts.length, 1, "关闭时同样不弹问题")
  assert.equal(method.prompts[0]?.key, "invite", "邀请码问题可留空 = 自动源")
  // 新语义：第一次 ask 一定返回「邀请码」问题（可留空 = 自动源）
  assert.equal((await method.ask({}))?.key, "invite", "第一次必须问邀请码（可留空）")
  assert.equal(await method.ask({ invite: "" }), null)
  assert.deepEqual(
    fetchImpl.shareCalls().map((c) => new URL(c.url).pathname),
    ["/r/CODE-LATEST", "/r/CODE-PREFERRED", "/r/CODE-LATEST"],
    "off = 最新账号（实时切换）",
  )
  const flowOff = await authorize(method, {})
  assert.equal(new URL(flowOff.url).searchParams.get("referral_state"), states["/r/CODE-LATEST"])
  assert.match(flowOff.instructions, /最新/)
  await finish(flowOff, "code-toggle-off")

  assert.equal(login.launches.length, 2)
  assert.deepEqual(login.launches.map((l) => l.closed), [1, 1], "两次都要关掉浏览器")
})

// ═══ ⑥ 换码不沿用旧 state ════════════════════════════════════════════

test("换码清旧 state；不同邀请码各自记录、互不覆盖", async () => {
  resetStore()
  const states = {
    "/r/CODE-A": "rs1.state.aaaa",
    "/r/CODE-B": "rs1.state.bbbb",
  }
  const fetchImpl = makeFetch({
    share: (path) => (states[path] ? { status: 200, body: shareHtml(states[path]) } : { status: 500, body: "boom" }),
  })
  const { method, login } = await makePlugin({ option: onOption(), fetchImpl })

  // 先问 A，再问 B
  await method.ask({ invite: "CODE-A" })
  await method.ask({ invite: "CODE-B" })
  assert.equal(fetchImpl.shareCalls().length, 2)

  // 策略文件：code 换成 B，state 也是 B 的
  let policy = readPolicy()
  assert.equal(policy.code, "CODE-B")
  assert.equal(policy.referralState, states["/r/CODE-B"])
  assert.ok(Number(policy.referralStateAt) > 0, "必须记下取 state 的时间")

  // 各自记录：拿 A 去 authorize 仍然包 A 的 state（B 不覆盖 A）
  const flowA = await authorize(method, { invite: "CODE-A" })
  await finish(flowA, "code-a")
  assert.equal(new URL(flowA.url).searchParams.get("referral_state"), states["/r/CODE-A"])

  const flowB = await authorize(method, { invite: "CODE-B" })
  await finish(flowB, "code-b")
  assert.equal(new URL(flowB.url).searchParams.get("referral_state"), states["/r/CODE-B"])

  // 换到 C：分享页失败 → 必须清掉旧 state，不能拿 A/B 的 state 去配 C
  await method.ask({ invite: "CODE-C" })
  policy = readPolicy()
  assert.equal(policy.code, "CODE-C")
  assert.equal(policy.referralState ?? "", "", "换码必须清掉旧 state（拿旧 rs1 配新码 = 邀请不生效）")
  assert.equal(policy.referralStateAt ?? "", "", "换码时时间戳也要一起清掉")

  const flowC = await authorize(method, { invite: "CODE-C" })
  await finish(flowC, "code-c")
  assert.equal(new URL(flowC.url).searchParams.get("referral_state"), null, "新码没有 state 就不能包装")
  assert.match(flowC.instructions, /邀请链接未准备（http_error/)

  assert.deepEqual(login.launches.map((l) => l.closed), [1, 1, 1])
})

// ═══ ⑦ 登录路径不碰 referrals 写面 ═══════════════════════════════════

test("整个登录流程没有任何 referrals 写端点（bind / code / me / relations）", async () => {
  resetStore()
  const fetchImpl = makeFetch({ share: () => ({ status: 200, body: shareHtml("rs1.no-writes") }) })
  const { method, login } = await makePlugin({ option: onOption(), fetchImpl })

  await method.ask({ invite: "INVITE-CODE-NOWRITE" })
  const flow = await authorize(method, { invite: "INVITE-CODE-NOWRITE" })
  const result = await finish(flow, "oauth-code-nowrite")
  assert.equal(result.type, "success", result.error)
  assert.equal(login.launches[0].closed, 1)

  for (const call of fetchImpl.calls) {
    assert.doesNotMatch(call.url, /referrals\//, "登录路径永不碰 referrals 写面")
  }
  assert.deepEqual(
    fetchImpl.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    [`GET /r/INVITE-CODE-NOWRITE`, `POST ${TOKEN_PATH}`, `GET ${PROFILE_PATH}`],
    "整个流程只允许这三类请求：分享页 GET（匿名）、换票 POST、profile GET",
  )
  // 分享页是匿名 GET：不带 Authorization / x-desktop-*
  const shareCall = fetchImpl.shareCalls()[0]
  assert.equal(shareCall.init.headers.authorization, undefined)
  assert.equal(Object.keys(shareCall.init.headers).some((k) => /^x-desktop-/i.test(k)), false)
  assert.equal(shareCall.init.redirect, "manual")
})

// ═══ ⑧ callback 失败也要清理 ═════════════════════════════════════════

test("callback 换票失败：隔离浏览器与 loopback 仍必须关掉", async () => {
  resetStore()
  const fetchImpl = makeFetch({
    share: () => ({ status: 200, body: shareHtml("rs1.callback-fail") }),
    token: () => new Response("boom", { status: 500 }),
  })
  const { method, login } = await makePlugin({ option: onOption(), fetchImpl })

  await method.ask({ invite: "INVITE-CODE-FAIL" })
  const baseline = loopbackServers()
  const flow = await authorize(method, { invite: "INVITE-CODE-FAIL" })
  const result = await finish(flow, "oauth-code-fail")

  assert.equal(result.type, "failed", "换票失败必须如实失败")
  assert.equal(login.launches[0].closed, 1, "失败路径同样要关浏览器")
  await settle()
  assert.equal(loopbackServers().length, baseline.length, "失败路径同样要关 loopback")
})
