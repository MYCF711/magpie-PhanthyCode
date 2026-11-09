// tests/invite-protocol.test.mjs —— 邀请登录协议（INVITE-PROTOCOL.md §6 C1–C9 / C14 / C15）
//
// 这里锁的是「登录 URL 上带 referral_state」这一条最小安全面：
//   · 授权 URL 必须逐字包进 `/login?next=…`（C1）
//   · 空码 / 非法码回退裸授权 URL，且零请求（C2）
//   · 只认 `rs1.` 前缀；只从 /login 或 /register 的 href 取（C3/C4）
//   · 分享页 GET 匿名、官方 UA、10s 超时、同 origin（C5/C6）
//   · 登录路径**永不**碰 referrals 写面（C7/C8）
//   · 策略存储的 referralState 同码继承 / 换码丢弃（C9）
//   · code 白名单（C14）与错误脱敏（C15）
//
// C10–C13（看板 / 错误分流）本次不实现，也不在这份文件里假绿。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 策略文件写在 ~/.cache/magpie 下，不能污染真实目录
const sandbox = mkdtempSync(join(tmpdir(), "invite-protocol-"))
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox

const invite = await import("../src/invite.mjs")
const {
  buildInviteLoginUrl,
  parseReferralState,
  referralShareUrl,
  fetchReferralState,
  createInviteStore,
  InvalidReferralCodeError,
  INVITE_LOGIN_PATH,
  INVITE_SHARE_PREFIX,
  INVITE_FETCH_TIMEOUT_MS,
} = invite
const { BASE } = await import("../src/context.mjs")
const { OFFICIAL_UA } = await import("../src/http.mjs")

// 一个「真实形状」的授权 URL：含 state / code_challenge / redirect_uri 与百分号编码
const AUTHORIZE_URL =
  "https://code.phanthy.com/oauth/authorize?client_id=phanthy-code-cli&response_type=code" +
  "&redirect_uri=http%3A%2F%2F127.0.0.1%3A19499%2Foauth%2Fcallback&scope=user%3Aprofile" +
  "&code_challenge=abc_123-XYZ&code_challenge_method=S256&state=opaque%2Bstate%3D1"

const SHARE_HTML = `<a href="/login?next=%2Foauth%2Fauthorize&amp;referral_state=rs1.abc.DEF-123">登录</a>`

/** 记录调用的假 fetch；返回 `Response`，默认是带合法 state 的分享页 */
function mockFetch({ status = 200, body = SHARE_HTML, headers = {} } = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(body, { status, headers })
  }
  fn.calls = calls
  return fn
}

// ── C1：授权 URL 包进 /login，next 逐字相等 ──────────────────────────

test("C1 合法 referral_state：/login?next=<完整授权URL>&referral_state=<state>", () => {
  const state = "rs1.abc.DEF-123_xyz"
  const out = buildInviteLoginUrl({ base: BASE, authorizeUrl: AUTHORIZE_URL, referralState: state })
  const url = new URL(out)

  assert.equal(url.origin, BASE)
  assert.equal(url.pathname, INVITE_LOGIN_PATH)
  // 解出来的 next 必须逐字等于原授权 URL（含 state / code_challenge / redirect_uri）
  assert.equal(url.searchParams.get("next"), AUTHORIZE_URL)
  assert.equal(url.searchParams.get("referral_state"), state)
  assert.deepEqual([...url.searchParams.keys()].sort(), ["next", "referral_state"])

  // 必须经 URLSearchParams 编码：原始串里 next 是百分号编码的，不是裸 URL
  assert.match(out, /[?&]next=https%3A%2F%2F/)
  assert.match(out, /referral_state=rs1\.abc\.DEF-123_xyz/)
})

test("C1 next 里有 + / % 时也只解一层，逐字相等", () => {
  const tricky = `${AUTHORIZE_URL}&note=a%2Bb%20c%25d`
  const out = buildInviteLoginUrl({ base: BASE, authorizeUrl: tricky, referralState: "rs1.s" })
  assert.equal(new URL(out).searchParams.get("next"), tricky)
})

// ── C2 / C3：空码、非法前缀、非法字符 → 原样返回授权 URL ─────────────

test("C2/C3 空码与非法 state 原样返回 authorizeUrl（零请求回退）", async () => {
  const fetchImpl = mockFetch()
  for (const state of ["", "   ", undefined, null, "rs1.", "rs1.a b", "rs1.a\nb", "rs2.abc", "RS1.abc", "rs1.a/b", "rs1.a&b"]) {
    assert.equal(
      buildInviteLoginUrl({ base: BASE, authorizeUrl: AUTHORIZE_URL, referralState: state }),
      AUTHORIZE_URL,
      `state=${JSON.stringify(state)} 必须回退裸授权 URL`,
    )
  }
  // 回退分支不产生任何网络调用
  assert.equal(fetchImpl.calls.length, 0)
})

test("C1 不可信 base 不回显到构造结果（回退授权 URL）", () => {
  assert.equal(
    buildInviteLoginUrl({
      base: "https://code.phanthy.com.evil.example",
      authorizeUrl: AUTHORIZE_URL,
      referralState: "rs1.abc",
    }),
    AUTHORIZE_URL,
  )
})

// L-2：next（= authorizeUrl）也必须过 origin 闸门 —— 导出函数不许成为开放重定向 gadget

test("L-2 不可信 next：绝不包装、原样返回，且不带 referral_state", () => {
  const state = "rs1.abc.DEF-123"
  const untrustedNext = [
    "https://evil.example/oauth/authorize?client_id=x",
    "https://code.phanthy.com.evil.example/oauth/authorize?client_id=x",
    "https://evil.phanthy.com/oauth/authorize?client_id=x",
    "http://code.phanthy.com/oauth/authorize?client_id=x",
    "https://user@code.phanthy.com/oauth/authorize",
    "https://user:user@code.phanthy.com/oauth/authorize", // 带 userinfo 一律拒
    "//evil.example/oauth/authorize",
    "/oauth/authorize?client_id=x", // 相对路径不是「完整授权 URL」
    "not a url",
    "",
  ]

  for (const authorizeUrl of untrustedNext) {
    const out = buildInviteLoginUrl({ base: BASE, authorizeUrl, referralState: state })
    assert.equal(out, authorizeUrl, `authorizeUrl=${JSON.stringify(authorizeUrl)} 必须原样返回、不包装`)
    assert.doesNotMatch(out, /referral_state/, "不可信 next 绝不带 referral_state")
    assert.doesNotMatch(out, /next=/, "不可信 next 绝不能被塞进 /login")
  }

  // 对照：可信 next 照常包装，且 next 逐字等于原授权 URL
  const ok = buildInviteLoginUrl({ base: BASE, authorizeUrl: AUTHORIZE_URL, referralState: state })
  assert.equal(new URL(ok).searchParams.get("next"), AUTHORIZE_URL)
})

// ── C3 / C4：HTML 解析只认 /login 或 /register 链接 ──────────────────

test("C3 只接受 rs1. 前缀，其它 / 畸形值返回空", () => {
  assert.equal(parseReferralState('<a href="/login?next=%2Fx&amp;referral_state=rs1.abc">x</a>'), "rs1.abc")
  assert.equal(parseReferralState('<a href="/register?referral_state=rs1.def">x</a>'), "rs1.def")
  // 别的 URL 形状、错误前缀、畸形值
  assert.equal(parseReferralState('<a href="/account/referrals?referral_state=rs1.abc">x</a>'), "")
  assert.equal(parseReferralState('<a href="https://evil.example/login?referral_state=rs1.abc">x</a>'), "")
  assert.equal(parseReferralState('<a href="//evil.example/login?referral_state=rs1.abc">x</a>'), "")
  assert.equal(parseReferralState('<a href="/login?referral_state=rs2.abc">x</a>'), "")
  assert.equal(parseReferralState('<a href="/login?referral_state=rs1.">x</a>'), "")
  assert.equal(parseReferralState('<a href="/login?referral_state=rs1.a%20b">x</a>'), "")
  assert.equal(parseReferralState(""), "")
  assert.equal(parseReferralState(null), "")
})

test("C4 多链接取第一个合法值；容忍 &amp;、单双引号、大小写", () => {
  const html = `
    <a href="/r/SHARE">分享</a>
    <a href="/login?referral_state=bad">坏值</a>
    <A HREF='/login?next=%2Fx&amp;referral_state=rs1.first'>单引号</A>
    <a href="/register?Referral_State=rs1.second">大小写</a>
  `
  assert.equal(parseReferralState(html), "rs1.first")

  // 同一 href 里前面有坏值、后面有合法值：取第一个合法
  assert.equal(
    parseReferralState('<a href="/login?referral_state=bad&amp;referral_state=rs1.good">x</a>'),
    "rs1.good",
  )
  // 无引号属性也要能认
  assert.equal(parseReferralState('<a href=/login?referral_state=rs1.unquoted>x</a>'), "rs1.unquoted")
})

// ── C5：分享页 GET 的匿名与安全形状 ─────────────────────────────────

test("C5 合法 code：仅一次匿名 GET，官方 UA / Accept / redirect:manual / signal", async () => {
  const fetchImpl = mockFetch()
  const out = await fetchReferralState({ base: BASE, code: "ABC-123_xyz", fetchImpl })

  assert.deepEqual(out, { state: "rs1.abc.DEF-123", reason: "" })
  assert.equal(fetchImpl.calls.length, 1)
  const [{ url, init }] = fetchImpl.calls

  assert.equal(url, `${BASE}${INVITE_SHARE_PREFIX}ABC-123_xyz`)
  assert.equal(init.method, "GET")
  assert.equal(init.redirect, "manual")
  assert.equal(init.headers["user-agent"], OFFICIAL_UA)
  assert.equal(init.headers.accept, "text/html")
  // 匿名：不带凭据，也不带设备签名头
  assert.equal(init.headers.authorization, undefined)
  assert.equal(
    Object.keys(init.headers).some((k) => /^x-desktop-/i.test(k)),
    false,
    "分享页不能带 x-desktop-*",
  )
  assert.ok(init.signal, "必须可被超时 / 调用方 signal 取消")
  assert.equal(INVITE_FETCH_TIMEOUT_MS, 10_000)
})

test("C5 非法 / 空 code：零 fetch，返回 invalid_code", async () => {
  const fetchImpl = mockFetch()
  for (const code of ["", "   ", undefined, null, "../evil", "a/b", "a b", "a\nb", "x".repeat(201)]) {
    const out = await fetchReferralState({ base: BASE, code, fetchImpl })
    assert.deepEqual(out, { state: "", reason: "invalid_code" }, `code=${JSON.stringify(code)}`)
  }
  assert.equal(fetchImpl.calls.length, 0)
})

test("C5 不可信 base：零 fetch，返回 untrusted_origin", async () => {
  const fetchImpl = mockFetch()
  const out = await fetchReferralState({ base: "https://evil.example", code: "ABC", fetchImpl })
  assert.deepEqual(out, { state: "", reason: "untrusted_origin" })
  assert.equal(fetchImpl.calls.length, 0)
})

// ── C6：分享页失败不阻塞登录 ─────────────────────────────────────────

test("C6 非 2xx / 3xx / 无 state / 网络错误都返回 {state:'',reason}，不抛", async () => {
  const cases = [
    [{ status: 500, body: "boom" }, "http_error"],
    [{ status: 404, body: "not found" }, "http_error"],
    [{ status: 302, body: "", headers: { location: `${BASE}/login` } }, "redirect"],
    [{ status: 200, body: "<html>没有链接</html>" }, "no_state"],
    [{ status: 200, body: '<a href="/login?referral_state=bad">x</a>' }, "no_state"],
  ]
  for (const [opts, reason] of cases) {
    const fetchImpl = mockFetch(opts)
    const out = await fetchReferralState({ base: BASE, code: "ABC", fetchImpl })
    assert.deepEqual(out, { state: "", reason }, `status=${opts.status}`)
    assert.equal(fetchImpl.calls.length, 1)
  }

  const throwing = async () => {
    throw new Error("socket hang up")
  }
  assert.deepEqual(await fetchReferralState({ base: BASE, code: "ABC", fetchImpl: throwing }), {
    state: "",
    reason: "network",
  })
})

test("C6 10s 超时：返回 timeout（不阻塞登录）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let calls = 0
  // 故意让注入的 fetch 既不 resolve 也不理会 signal：超时必须由模块自己兜底
  const fetchImpl = () => {
    calls += 1
    return new Promise(() => {})
  }

  const pending = fetchReferralState({ base: BASE, code: "ABC", fetchImpl })
  t.mock.timers.tick(INVITE_FETCH_TIMEOUT_MS)
  const out = await pending

  assert.deepEqual(out, { state: "", reason: "timeout" })
  assert.equal(calls, 1)
})

test("C6 调用方 signal：可合并、可取消；已取消则零 fetch", async () => {
  // 已取消
  const pre = new AbortController()
  pre.abort()
  let calls = 0
  const never = async () => {
    calls += 1
    return new Response(SHARE_HTML, { status: 200 })
  }
  assert.deepEqual(await fetchReferralState({ base: BASE, code: "ABC", fetchImpl: never, signal: pre.signal }), {
    state: "",
    reason: "aborted",
  })
  assert.equal(calls, 0)

  // 请求途中取消
  const ac = new AbortController()
  const hung = (url, init) => {
    calls += 1
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    })
  }
  const pending = fetchReferralState({ base: BASE, code: "ABC", fetchImpl: hung, signal: ac.signal })
  ac.abort()
  assert.deepEqual(await pending, { state: "", reason: "aborted" })
  assert.equal(calls, 1)
})

// ── C7 / C8：登录路径不碰 referrals 写面 ────────────────────────────

test("C7/C8 分享页流程只请求 /r/<code>，绝不 POST referrals/bind|code|me|relations", async () => {
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method ?? "GET" })
    return new Response(SHARE_HTML, { status: 200 })
  }

  const out = await fetchReferralState({ base: BASE, code: "CODE-1", fetchImpl })
  assert.equal(out.state, "rs1.abc.DEF-123")
  assert.equal(seen.length, 1)
  for (const c of seen) {
    assert.equal(c.method, "GET")
    assert.equal(/^\/r\//.test(new URL(c.url).pathname), true)
    assert.doesNotMatch(c.url, /referrals\/(bind|code|me|relations)/)
  }
})

// ── C14：code 白名单 ────────────────────────────────────────────────

test("C14 referralShareUrl：code 白名单 ^[A-Za-z0-9._-]{1,200}$，同 origin", () => {
  assert.equal(referralShareUrl(BASE, "ABC-123_x.y"), `${BASE}/r/ABC-123_x.y`)
  assert.equal(referralShareUrl(BASE, "a".repeat(200)), `${BASE}/r/${"a".repeat(200)}`)

  const bad = ["", "  ", "../evil", "a/b", "a b", "a\nb", "a+b", "a&b", "a?b", "a#b", "中文", "a".repeat(201)]
  for (const code of bad) {
    assert.throws(
      () => referralShareUrl(BASE, code),
      (err) => err instanceof InvalidReferralCodeError && err.code === "invalid_code",
      `code=${JSON.stringify(code)} 必须被白名单拒绝`,
    )
  }

  // 不可信 base 由 trustedUrlOf 拒掉
  assert.throws(() => referralShareUrl("https://evil.example", "ABC"), /可信 origin/)
  assert.throws(() => referralShareUrl("http://code.phanthy.com", "ABC"), /可信 origin/)
})

// ── C9：策略存储的 referralState（同码继承 / 换码丢弃）───────────────

test("C9 createInviteStore：referralState 同码继承、换码丢弃，旧 API 不变", () => {
  const store = createInviteStore("zzrefstate")

  store.write("CODE-1", { source: "chosen", extra: { referralState: "rs1.one", referralStateAt: 111 } })
  assert.equal(store.read(), "CODE-1")
  assert.equal(store.readExtra("referralState"), "rs1.one")
  assert.equal(store.readExtra("referralStateAt"), "111")

  // 同码重写、不带 extra → 继承
  store.write("CODE-1", { source: "used" })
  assert.equal(store.readExtra("referralState"), "rs1.one")
  assert.equal(store.readExtra("referralStateAt"), "111")

  // 换码、不带 extra → 旧 state 必须丢掉（不能拿旧 rs1 配新码）
  store.write("CODE-2", { source: "chosen" })
  assert.equal(store.read(), "CODE-2")
  assert.equal(store.readExtra("referralState"), "")
  assert.equal(store.readExtra("referralStateAt"), "")

  // 空码不覆盖已有策略
  store.write("", { extra: { referralState: "rs1.empty" } })
  assert.equal(store.read(), "CODE-2")
  assert.equal(store.readExtra("referralState"), "")
})

// ── C15：错误脱敏（referral_state / invite_code / code 原值不进文案）──

test("C15 失败结果与错误文案不回显 state / code 原值", async () => {
  const secretState = "rs1.credential-looking-" + "A".repeat(120)
  const html = `<a href="/login?referral_state=${encodeURIComponent(secretState + " ")}">x</a>`
  const fetchImpl = mockFetch({ body: html })
  const out = await fetchReferralState({ base: BASE, code: "SAFE-CODE", fetchImpl })
  assert.deepEqual(out, { state: "", reason: "no_state" })
  assert.doesNotMatch(JSON.stringify(out), /credential-looking/)

  // 非法 code 的错误文案不含原值
  const secretCode = "credential-looking-" + "x".repeat(200)
  try {
    referralShareUrl(BASE, secretCode)
    assert.fail("非法 code 必须抛")
  } catch (err) {
    assert.equal(err.code, "invalid_code")
    assert.doesNotMatch(err.message, /credential-looking/)
    assert.doesNotMatch(err.message, /x{20}/)
  }

  // parse 对凭据样式（无 rs1. 前缀）的长串一律返回空，不把它带到调用方
  assert.equal(parseReferralState('<a href="/login?referral_state=long-credential-looking-token">x</a>'), "")
})
