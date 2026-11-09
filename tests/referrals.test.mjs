// tests/referrals.test.mjs —— 账号自己的邀请链接（INVITE-SOURCE-CONTRACT.md §3；B1–B13）
//
// 全部离线：fetch 一律注入，断言「发了什么」而不是「上游怎么答」。
// 锁的契约：
//   · GET /referrals/me 只有资格，没有 code / share_url；没码也不算失败（B1）
//   · POST /referrals/code 的 body 是字面量 {}，幂等键 referral-code:<id>:<ms>，
//     v1 canonical 可被 identity 公钥验签（B10）
//   · 设备未注册 → device_required，零请求（B11）
//   · eligible_to_invite=false → ineligible，零 POST（B11）
//   · codes[5] 全收，主码 = 最小正 slot（B2/B5）
//   · share_url 只认同 origin，跨 origin / 非 https 一律丢弃并用 code 派生（B4）
//   · 401/409/503/网络/畸形响应分类，且不重试（B9）
//   · 永不出现 referrals/bind、永不打 /r/、永不把 Bearer 发给分享页（C7/C8/B12/B13）

import test from "node:test"
import assert from "node:assert/strict"

import {
  REFERRAL_ME_PATH,
  REFERRAL_CODE_PATH,
  REFERRAL_CODE_PREFIX,
  REFERRAL_CODE_BODY,
  REFERRAL_SHARE_PREFIX,
  readReferralMe,
  readReferralCode,
  pickPrimarySlot,
  trustedShareUrl,
  referralCodeIdempotencyKey,
  classifyReferralError,
  isDeviceRegistered,
  fetchReferralMe,
  fetchReferralCode,
} from "../src/referrals.mjs"
import { BASE } from "../src/context.mjs"
import { OFFICIAL_UA } from "../src/http.mjs"
import { createInstallation } from "../src/device-key.mjs"
import { importPublicKey, verifyCanonical, v1Canonical } from "../src/proof.mjs"

const AUTH = { type: "oauth", access: "access-test" }
const SCOPE = "8f14e45f-ceea-467a-9c1f-2b3d4e5f6a7b"
const NOW = 1_700_000_123_456

/** 一条「已注册」的安装记录（纯内存生成，不落盘） */
function recordFor({ registered = true } = {}) {
  const created = createInstallation({ account: "acct-referrals", now: () => NOW })
  return { ...created, accountScope: SCOPE, registeredAt: registered ? NOW - 1_000 : 0 }
}

const ME_OK = {
  schema_version: 1,
  referral: {
    program_status: "active",
    eligible_to_invite: true,
    eligibility_reason: null,
    reward_points: 5000,
    reward_tiers: [5000, 8000, 10000],
    tier_granted_count: 0,
    tier_allocated_count: 0,
    next_reward_points: 5000,
    daily_committed: 0,
    daily_granted: 0,
    daily_limit: 50,
    total_granted: 0,
    pending_count: 0,
    total_occupied: 0,
    total_limit: 50,
    remaining_slots: 50,
    recent_relations: [],
    invited_progress: null,
  },
}

const ME_INELIGIBLE = {
  schema_version: 1,
  referral: {
    program_status: "active",
    eligible_to_invite: false,
    eligibility_reason: "desktop_activation_required",
    reward_points: 5000,
    daily_limit: 50,
    total_limit: 50,
    remaining_slots: 50,
  },
}

const CODE_1 = "primary-code_AAA-111"
const CODE_2 = "second-code_BBB-222"
const CODE_3 = "third-code_CCC-333"
const CODE_4 = "fourth-code_DDD-444"
const CODE_5 = "fifth-code_EEE-555"

function slot(n, code, { invite = `INV-${n}`, share } = {}) {
  return { slot: n, code, invite_code: invite, share_url: share ?? `${BASE}/r/${code}` }
}

/** 顶层字段齐全、codes 故意乱序（证明选的是最小正 slot，不是数组第一个） */
const CODE_OK = {
  schema_version: 1,
  code: CODE_1,
  invite_code: "ABCD-EFGH-JK23",
  share_url: `${BASE}/r/${CODE_1}`,
  codes: [slot(3, CODE_3), slot(1, CODE_1, { invite: "ABCD-EFGH-JK23" }), slot(5, CODE_5), slot(2, CODE_2), slot(4, CODE_4)],
  unknown_field: "must-be-dropped",
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/**
 * 记录调用的假 fetch。routes 的键是 pathname；值可以是
 * `{status, body}`、`Response`、`Error`（抛出去），或函数。
 */
function recorder(routes = {}) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, init })
    const path = new URL(href).pathname
    const key = Object.keys(routes).find((k) => path === k)
    const spec = key ? routes[key] : { status: 404, body: { error: { code: "not_found" } } }
    const out = typeof spec === "function" ? await spec(href, init) : spec
    if (out instanceof Error) throw out
    if (out instanceof Response) return out
    return json(out.body ?? {}, out.status ?? 200)
  }
  return { calls, fetchImpl }
}

// ── B1：/me 只有资格，没有码 ────────────────────────────────────────

test("GET /referrals/me：纯 Bearer + 官方 UA + redirect manual，零签名头；没码也不失败", async () => {
  const { calls, fetchImpl } = recorder({ [REFERRAL_ME_PATH]: { body: ME_OK } })
  const res = await fetchReferralMe(AUTH, { fetchImpl })

  assert.equal(res.ok, true)
  assert.equal(res.me.eligible, true)
  assert.equal(res.me.eligibilityReason, null)
  assert.equal(res.me.programStatus, "active")
  assert.equal(res.me.rewardPoints, 5000)
  assert.deepEqual(res.me.rewardTiers, [5000, 8000, 10000])
  assert.equal(res.me.remainingSlots, 50)

  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(new URL(call.url).pathname, REFERRAL_ME_PATH)
  assert.equal(call.init.method, "GET")
  assert.equal(call.init.body, undefined, "GET /me 没有 body")
  assert.equal(call.init.headers.authorization, "Bearer access-test")
  assert.equal(call.init.headers["user-agent"], OFFICIAL_UA)
  assert.equal(call.init.headers["x-phanthy-client-source"], "desktop")
  assert.equal(call.init.redirect, "manual")
  for (const header of [
    "x-desktop-installation-id",
    "x-desktop-timestamp",
    "x-desktop-nonce",
    "x-desktop-signature",
    "idempotency-key",
  ]) {
    assert.equal(header in call.init.headers, false, `/me 不能带签名/幂等头：${header}`)
  }

  // /me 的解析结果里绝不允许出现码 / 链接
  for (const forbidden of ['"code"', '"codes"', '"share_url"', '"invite_code"']) {
    assert.equal(JSON.stringify(res.me).includes(forbidden), false, `me 不许含 ${forbidden}`)
  }
})

test("readReferralMe：字段白名单，夹带的 code / share_url 一律丢掉", () => {
  const me = readReferralMe({
    schema_version: 1,
    referral: {
      eligible_to_invite: true,
      eligibility_reason: "x",
      reward_points: "5000",
      reward_tiers: [5000, "bad", 8000],
      code: "LEAK-CODE",
      share_url: "https://evil.example/r/LEAK-CODE",
      invite_code: "LEAK-INVITE",
    },
    code: "LEAK-TOP",
    share_url: "https://evil.example/r/LEAK-TOP",
  })

  assert.deepEqual(Object.keys(me).sort(), [
    "dailyLimit",
    "eligibilityReason",
    "eligible",
    "nextRewardPoints",
    "programStatus",
    "remainingSlots",
    "rewardPoints",
    "rewardTiers",
    "schemaVersion",
    "tierAllocatedCount",
    "tierGrantedCount",
    "totalLimit",
  ])
  assert.equal(me.rewardPoints, 5000)
  assert.deepEqual(me.rewardTiers, [5000, 8000])
  assert.equal(me.eligibilityReason, "x")

  const text = JSON.stringify(me)
  for (const forbidden of ["LEAK-CODE", "LEAK-TOP", "LEAK-INVITE", "evil.example"]) {
    assert.equal(text.includes(forbidden), false)
  }

  // 缺字段 → null，不编造 0
  const empty = readReferralMe({})
  assert.equal(empty.rewardPoints, null)
  assert.equal(empty.tierGrantedCount, null)
  assert.equal(empty.eligible, false)
  assert.equal(empty.eligibilityReason, null)
  assert.deepEqual(empty.rewardTiers, [])
})

// ── B11：设备未注册 → device_required，零请求 ────────────────────────

test("设备未注册 → device_required，零 POST（也零 GET）", async () => {
  const record = recordFor({ registered: false })
  const { calls, fetchImpl } = recorder({
    [REFERRAL_ME_PATH]: { body: ME_OK },
    [REFERRAL_CODE_PATH]: { body: CODE_OK },
  })

  const res = await fetchReferralCode(AUTH, { record, fetchImpl })
  assert.deepEqual(res, { ok: false, reason: "device_required" })
  assert.equal(calls.length, 0, "设备未注册时一条请求都不发，更不能 POST")
})

test("isDeviceRegistered：只认「记录 + identity 公钥同源」；不要求推理令牌", () => {
  const record = recordFor()
  assert.equal(isDeviceRegistered(record), true)

  assert.equal(isDeviceRegistered(null), false)
  assert.equal(isDeviceRegistered({}), false)
  assert.equal(isDeviceRegistered({ ...record, registeredAt: 0 }), false)
  assert.equal(isDeviceRegistered({ ...record, accountScope: "" }), false)
  assert.equal(isDeviceRegistered({ ...record, installationId: "" }), false)
  assert.equal(isDeviceRegistered({ ...record, installationId: "di_not-derived-from-key" }), false)
  assert.equal(isDeviceRegistered({ ...record, publicKey: "not-a-spki-key" }), false)
  // 推理令牌是推理面的前提，不是拿邀请码的前提
  assert.equal(isDeviceRegistered({ ...record, inferenceToken: "" }), true)
})

test("设备注册曾 409（熔断期内）→ 零请求，分类为 conflict", async () => {
  const record = { ...recordFor(), registrationUnavailableAt: NOW - 1_000 }
  const { calls, fetchImpl } = recorder({
    [REFERRAL_ME_PATH]: { body: ME_OK },
    [REFERRAL_CODE_PATH]: { body: CODE_OK },
  })
  const res = await fetchReferralCode(AUTH, { record, fetchImpl, now: () => NOW })
  assert.deepEqual(res, { ok: false, reason: "failed", failure: "conflict", status: 409 })
  assert.equal(calls.length, 0, "熔断期内一条请求都不发（不 force 注册设备）")
})

// ── B10：POST 的 body / 幂等键 / canonical ───────────────────────────

test("成功：POST body 是 {}、幂等键 referral-code:<id>:<ms>、v1 canonical 可验签", async () => {
  const record = recordFor()
  const { calls, fetchImpl } = recorder({
    [REFERRAL_ME_PATH]: { body: ME_OK },
    [REFERRAL_CODE_PATH]: { body: CODE_OK },
  })

  const res = await fetchReferralCode(AUTH, { record, fetchImpl, now: () => NOW })
  assert.equal(res.ok, true)
  assert.equal(res.code, CODE_1)
  assert.equal(res.inviteCode, "ABCD-EFGH-JK23")
  assert.equal(res.shareUrl, `${BASE}/r/${CODE_1}`)
  assert.equal(res.slot, 1)
  assert.equal(res.slots.length, 5, "codes[5] 全部保留")

  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    [REFERRAL_ME_PATH, REFERRAL_CODE_PATH],
    "先读资格，再取码",
  )
  const post = calls[1]
  assert.equal(post.init.method, "POST")
  assert.equal(post.init.body, "{}", "body 必须是字面量 {}（参与 canonical 的 sha256）")
  assert.equal(post.init.redirect, "manual")
  assert.equal(post.init.headers.authorization, "Bearer access-test")
  assert.equal(post.init.headers["user-agent"], OFFICIAL_UA)
  assert.equal(post.init.headers["x-phanthy-client-source"], "desktop")
  assert.equal(post.init.headers["x-desktop-installation-id"], record.installationId)

  const key = post.init.headers["idempotency-key"]
  assert.equal(key, `referral-code:${record.installationId}:${NOW}`)
  assert.equal(key, referralCodeIdempotencyKey(record.installationId, NOW))

  const timestamp = post.init.headers["x-desktop-timestamp"]
  const nonce = post.init.headers["x-desktop-nonce"]
  assert.equal(timestamp, String(NOW))
  assert.match(nonce, /^[A-Za-z0-9_-]{16,}$/)

  const publicKey = importPublicKey(record.publicKey)
  const canonical = v1Canonical({
    method: "POST",
    upstreamPath: REFERRAL_CODE_PATH,
    timestamp,
    nonce,
    body: post.init.body,
    idempotencyKey: key,
  })
  assert.equal(
    verifyCanonical(publicKey, canonical, post.init.headers["x-desktop-signature"]),
    true,
    "签名必须能被 identity 公钥验过",
  )
  // 换一个幂等键就验不过 —— 证明它确实进了 canonical 第 7 段
  const otherKey = referralCodeIdempotencyKey(record.installationId, NOW + 1)
  assert.equal(
    verifyCanonical(
      publicKey,
      v1Canonical({
        method: "POST",
        upstreamPath: REFERRAL_CODE_PATH,
        timestamp,
        nonce,
        body: post.init.body,
        idempotencyKey: otherKey,
      }),
      post.init.headers["x-desktop-signature"],
    ),
    false,
  )
})

test("referralCodeIdempotencyKey：形状固定，非法输入直接抛（不猜）", () => {
  assert.equal(REFERRAL_CODE_PREFIX, "referral-code")
  assert.equal(referralCodeIdempotencyKey("di_abc", NOW), `referral-code:di_abc:${NOW}`)
  assert.equal(referralCodeIdempotencyKey(" di_abc ", () => NOW), `referral-code:di_abc:${NOW}`)
  assert.throws(() => referralCodeIdempotencyKey("", NOW), TypeError)
  assert.throws(() => referralCodeIdempotencyKey("   ", NOW), TypeError)
  assert.throws(() => referralCodeIdempotencyKey("di_abc", () => Number.NaN), TypeError)
  assert.throws(() => referralCodeIdempotencyKey("di_abc", "not-a-number"), TypeError)
})

// ── B11：eligible=false → ineligible，零 POST ────────────────────────

test("eligible_to_invite=false → ineligible，零 POST（只读一次 /me）", async () => {
  const record = recordFor()
  const { calls, fetchImpl } = recorder({
    [REFERRAL_ME_PATH]: { body: ME_INELIGIBLE },
    [REFERRAL_CODE_PATH]: { body: CODE_OK },
  })

  const res = await fetchReferralCode(AUTH, { record, fetchImpl })
  assert.equal(res.ok, false)
  assert.equal(res.reason, "ineligible")
  assert.equal(res.eligibilityReason, "desktop_activation_required")
  assert.equal(res.me.eligible, false)

  assert.equal(calls.length, 1, "只允许读一次资格")
  assert.equal(new URL(calls[0].url).pathname, REFERRAL_ME_PATH)
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 0, "没资格时零 POST")
})

// ── B2/B5：codes[5] 全收，主码 = 最小正 slot ─────────────────────────

test("成功：codes 乱序时仍取最小正 slot（slot 1），并保留全部 5 个", async () => {
  const body = {
    schema_version: 1,
    codes: [slot(4, CODE_4), slot(2, CODE_2), slot(5, CODE_5), slot(1, CODE_1), slot(3, CODE_3)],
  }
  const record = recordFor()
  const { calls, fetchImpl } = recorder({
    [REFERRAL_ME_PATH]: { body: ME_OK },
    [REFERRAL_CODE_PATH]: { body },
  })

  const res = await fetchReferralCode(AUTH, { record, fetchImpl, now: () => NOW })
  assert.equal(res.ok, true)
  assert.equal(res.slot, 1, "不是数组第一个（数组第一个是 slot 4）")
  assert.equal(res.code, CODE_1)
  assert.equal(res.shareUrl, `${BASE}/r/${CODE_1}`, "顶层 share_url 缺失时由 code 派生")
  assert.deepEqual(
    res.slots.map((s) => s.slot),
    [4, 2, 5, 1, 3],
    "全部 5 个 slot 都要留着（顺序即上游顺序）",
  )
  for (const entry of res.slots) assert.match(entry.shareUrl, new RegExp(`^${BASE.replace(/\./g, "\\.")}/r/`))
})

test("pickPrimarySlot：最小正 slot；空 / 非法 / 非正整数一律跳过", () => {
  const a = { slot: 3, code: CODE_3 }
  const b = { slot: 1, code: CODE_1 }
  const c = { slot: 2, code: CODE_2 }
  assert.equal(pickPrimarySlot([a, c, b]), b)
  assert.equal(pickPrimarySlot([]), null)
  assert.equal(pickPrimarySlot(null), null)
  assert.equal(pickPrimarySlot(undefined), null)

  const invalid = [
    null,
    {},
    { slot: 0, code: CODE_1 },
    { slot: -1, code: CODE_1 },
    { slot: "1", code: CODE_1 },
    { slot: 1.5, code: CODE_1 },
    { slot: 1, code: "" },
    { slot: 1, code: "bad code with spaces" },
    { slot: 1, code: "bad/code" },
    { slot: 1, code: "line\nbreak" },
  ]
  assert.equal(pickPrimarySlot(invalid), null)
  assert.deepEqual(
    pickPrimarySlot([{ slot: 9, code: CODE_5 }, { slot: 2, code: CODE_2 }, ...invalid]),
    { slot: 2, code: CODE_2 },
  )
})

test("readReferralCode：字段白名单 + 每个 slot 的 share_url 都过同 origin", () => {
  const parsed = readReferralCode({
    schema_version: 1,
    code: CODE_1,
    invite_code: "ABCD-EFGH-JK23",
    share_url: "https://evil.example/r/" + CODE_1,
    codes: [
      slot(1, CODE_1, { share: "https://evil.example/r/" + CODE_1 }),
      slot(2, CODE_2, { share: "http://code.phanthy.com/r/" + CODE_2 }),
      slot(3, CODE_3, { share: "https://code.phanthy.com/r/" + CODE_4 }),
      slot(4, CODE_4),
      { slot: 5, code: "bad code", invite_code: "X", share_url: "https://evil.example/r/x" },
      { slot: 6, code: CODE_5, invite_code: "ok", share_url: `${BASE}/r/${CODE_5}`, extra: "dropped" },
    ],
    extra: "dropped",
  })

  assert.equal(parsed.code, CODE_1)
  assert.equal(parsed.inviteCode, "ABCD-EFGH-JK23")
  assert.equal(parsed.shareUrl, `${BASE}/r/${CODE_1}`, "跨 origin 的顶层 share_url 必须丢弃后派生")
  assert.deepEqual(parsed.slots.map((s) => s.slot), [1, 2, 3, 4, 6], "非法 code 的 slot 被丢，其余全留")
  // 跨 origin / 非 https / 指向别的 code 的 share_url 全部改派生
  assert.equal(parsed.slots[0].shareUrl, `${BASE}/r/${CODE_1}`)
  assert.equal(parsed.slots[1].shareUrl, `${BASE}/r/${CODE_2}`)
  assert.equal(parsed.slots[2].shareUrl, `${BASE}/r/${CODE_3}`)
  assert.equal(parsed.slots[3].shareUrl, `${BASE}/r/${CODE_4}`)
  assert.deepEqual(Object.keys(parsed.slots[4]).sort(), ["code", "inviteCode", "shareUrl", "slot"])

  const empty = readReferralCode({})
  assert.equal(empty.code, "")
  assert.equal(empty.shareUrl, "")
  assert.deepEqual(empty.slots, [])
  assert.deepEqual(readReferralCode({ codes: "not-an-array" }).slots, [])
})

// ── B4：share_url 同 origin；缺失 / 跨 origin 用 code 派生 ─────────────

test("trustedShareUrl：同 origin 且指向同一个 code 才原样用；其余一律派生", () => {
  assert.equal(REFERRAL_SHARE_PREFIX, "/r/")
  assert.equal(trustedShareUrl(CODE_1), `${BASE}/r/${CODE_1}`)
  assert.equal(trustedShareUrl(CODE_1, `${BASE}/r/${CODE_1}`), `${BASE}/r/${CODE_1}`)
  assert.equal(trustedShareUrl(CODE_1, `${BASE}/r/${CODE_2}`), `${BASE}/r/${CODE_1}`, "链接必须指向主码")
  assert.equal(trustedShareUrl(CODE_1, "https://evil.example/r/" + CODE_1), `${BASE}/r/${CODE_1}`)
  assert.equal(trustedShareUrl(CODE_1, "https://code.phanthy.com.evil.example/r/" + CODE_1), `${BASE}/r/${CODE_1}`)
  assert.equal(trustedShareUrl(CODE_1, "http://code.phanthy.com/r/" + CODE_1), `${BASE}/r/${CODE_1}`)
  assert.equal(trustedShareUrl(CODE_1, "https://user@code.phanthy.com/r/" + CODE_1), `${BASE}/r/${CODE_1}`)
  assert.equal(trustedShareUrl("bad code", `${BASE}/r/x`), "")
  assert.equal(trustedShareUrl("", `${BASE}/r/x`), "")
  assert.equal(trustedShareUrl("../escape"), "")
})

test("code 白名单与 src/invite.mjs 的 C14 判据保持同一套（接受集合一致）", async () => {
  const { referralShareUrl: inviteShareUrl } = await import("../src/invite.mjs")
  const samples = [
    CODE_1,
    "ABC123",
    "a.b_c-d",
    "",
    " space",
    "bad space",
    "line\nbreak",
    "tab\tbreak",
    "slash/code",
    "..",
    ".hidden",
    "%2e%2e",
    "中文",
    "x".repeat(200),
    "x".repeat(201),
  ]
  for (const sample of samples) {
    let inviteAccepts = true
    try {
      inviteShareUrl(BASE, sample)
    } catch {
      inviteAccepts = false
    }
    assert.equal(trustedShareUrl(sample) !== "", inviteAccepts, `接受集合分叉：${JSON.stringify(sample.slice(0, 20))}`)
  }
})

// ── B9：错误分流，且一律不重试 ───────────────────────────────────────

test("classifyReferralError：401/409/503/网络/畸形响应对号入座，且不回显 body 原文", () => {
  const body = (code) => ({ error: { code, message: "maybe contains a secret code" } })
  const cases = [
    [{ status: 200 }, "invalid_response"],
    [{ status: 201 }, "invalid_response"],
    [{ status: 0 }, "network"],
    [{}, "network"],
    [{ status: 400, body: body("invalid_referral_state") }, "invalid_request"],
    [{ status: 401, body: body("desktop_installation_required") }, "device_required"],
    [{ status: 401, body: body("missing_login") }, "missing_login"],
    [{ status: 401, body: body("invalid_desktop_signature") }, "signature_invalid"],
    [{ status: 401, body: body("idempotency_key_required") }, "idempotency_required"],
    [{ status: 401, body: body("something_else") }, "unauthorized"],
    [{ status: 404 }, "not_supported"],
    [{ status: 409, body: body("desktop_installation_conflict") }, "conflict"],
    [{ status: 409 }, "conflict"],
    [{ status: 429 }, "rate_limited"],
    [{ status: 503, body: body("dependency_unavailable") }, "idempotency_required"],
    [{ status: 503 }, "unavailable"],
    [{ status: 500 }, "unavailable"],
    [{ status: 502 }, "unavailable"],
  ]
  for (const [input, failure] of cases) {
    const out = classifyReferralError(input)
    assert.deepEqual(Object.keys(out).sort(), ["failure", "status"])
    assert.equal(out.failure, failure, `${JSON.stringify(input)} → ${failure}`)
  }

  // 只读 error.code 白名单，绝不把上游 message / body 原样带回
  const leaky = classifyReferralError({
    status: 503,
    body: { error: { code: "SHARE_URL-https://code.phanthy.com/r/SECRET", message: "SECRET-CODE-XYZ" } },
  })
  assert.deepEqual(leaky, { failure: "unavailable", status: 503 })
  assert.equal(JSON.stringify(leaky).includes("SECRET"), false)
})

test("401 desktop_installation_required：分类为 device_required，且只 POST 一次（不重试）", async () => {
  const record = recordFor()
  const { calls, fetchImpl } = recorder({
    [REFERRAL_ME_PATH]: { body: ME_OK },
    [REFERRAL_CODE_PATH]: { status: 401, body: { error: { code: "desktop_installation_required", message: "x" } } },
  })
  const res = await fetchReferralCode(AUTH, { record, fetchImpl, now: () => NOW })
  assert.deepEqual(res, { ok: false, reason: "failed", failure: "device_required", status: 401 })
  assert.equal(calls.length, 2)
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1, "401 不重试")
})

test("401 missing_login（/me 上）：分类 + 不重试", async () => {
  const record = recordFor()
  const { calls, fetchImpl } = recorder({
    [REFERRAL_ME_PATH]: { status: 401, body: { error: { code: "missing_login", message: "x" } } },
  })
  const res = await fetchReferralCode(AUTH, { record, fetchImpl })
  assert.deepEqual(res, { ok: false, reason: "failed", failure: "missing_login", status: 401 })
  assert.equal(calls.length, 1)
})

test("409 desktop_installation_conflict：终态，不重试", async () => {
  const record = recordFor()
  const { calls, fetchImpl } = recorder({
    [REFERRAL_ME_PATH]: { body: ME_OK },
    [REFERRAL_CODE_PATH]: { status: 409, body: { error: { code: "desktop_installation_conflict", message: "x" } } },
  })
  const res = await fetchReferralCode(AUTH, { record, fetchImpl, now: () => NOW })
  assert.deepEqual(res, { ok: false, reason: "failed", failure: "conflict", status: 409 })
  assert.equal(calls.length, 2)
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1, "409 不重试")
})

test("503 dependency_unavailable：是幂等键问题，不是服务故障，不重试", async () => {
  const record = recordFor()
  const { calls, fetchImpl } = recorder({
    [REFERRAL_ME_PATH]: { body: ME_OK },
    [REFERRAL_CODE_PATH]: { status: 503, body: { error: { code: "dependency_unavailable", message: "x" } } },
  })
  const res = await fetchReferralCode(AUTH, { record, fetchImpl, now: () => NOW })
  assert.deepEqual(res, { ok: false, reason: "failed", failure: "idempotency_required", status: 503 })
  assert.equal(calls.length, 2)
  assert.equal(calls.filter((c) => c.init.method === "POST").length, 1, "503 不换 key 重试")
})

test("其它 503 / 404：如实分类，不重试", async () => {
  for (const [status, failure] of [
    [503, "unavailable"],
    [404, "not_supported"],
    [500, "unavailable"],
  ]) {
    const record = recordFor()
    const { calls, fetchImpl } = recorder({
      [REFERRAL_ME_PATH]: { body: ME_OK },
      [REFERRAL_CODE_PATH]: { status, body: { error: { code: "x" } } },
    })
    const res = await fetchReferralCode(AUTH, { record, fetchImpl, now: () => NOW })
    assert.deepEqual(res, { ok: false, reason: "failed", failure, status })
    assert.equal(calls.length, 2, `${status} 不重试`)
  }
})

test("网络错误：失败但不抛，调用方不会被阻断", async () => {
  const record = recordFor()
  const { calls, fetchImpl } = recorder({
    [REFERRAL_ME_PATH]: { body: ME_OK },
    [REFERRAL_CODE_PATH]: () => new Error("socket hang up"),
  })
  const res = await fetchReferralCode(AUTH, { record, fetchImpl, now: () => NOW })
  assert.deepEqual(res, { ok: false, reason: "failed", failure: "network", status: 0 })
  assert.equal(calls.length, 2, "网络错误只发一次 POST，不重试")
})

test("畸形响应（200 非 JSON / 空对象）：invalid_response / no_code，不抛", async () => {
  const record = recordFor()

  const notJson = recorder({
    [REFERRAL_ME_PATH]: { body: ME_OK },
    [REFERRAL_CODE_PATH]: new Response("this is not json", { status: 200, headers: { "content-type": "text/html" } }),
  })
  const bad = await fetchReferralCode(AUTH, { record, fetchImpl: notJson.fetchImpl, now: () => NOW })
  assert.deepEqual(bad, { ok: false, reason: "failed", failure: "invalid_response", status: 200 })
  assert.equal(notJson.calls.length, 2)

  const empty = recorder({
    [REFERRAL_ME_PATH]: { body: ME_OK },
    [REFERRAL_CODE_PATH]: { body: {} },
  })
  const none = await fetchReferralCode(AUTH, { record, fetchImpl: empty.fetchImpl, now: () => NOW })
  assert.deepEqual(none, { ok: false, reason: "failed", failure: "no_code", status: 200 })
  assert.equal(empty.calls.length, 2)

  const meBad = recorder({ [REFERRAL_ME_PATH]: new Response("<html>", { status: 200 }) })
  const meRes = await fetchReferralMe(AUTH, { fetchImpl: meBad.fetchImpl })
  assert.deepEqual(meRes, { ok: false, reason: "failed", failure: "invalid_response", status: 200 })
  assert.equal(meBad.calls.length, 1)
})

// ── B12/B13：不碰 bind、不碰推理端点、不抓 /r/ ────────────────────────

test("全流程：永不 bind、永不碰推理端点、永不抓 /r/（Bearer 不发给分享页）", async () => {
  const record = recordFor()
  const { calls, fetchImpl } = recorder({
    [REFERRAL_ME_PATH]: { body: ME_OK },
    [REFERRAL_CODE_PATH]: { body: CODE_OK },
  })
  const res = await fetchReferralCode(AUTH, { record, fetchImpl, now: () => NOW })
  assert.equal(res.ok, true)

  for (const call of calls) {
    const url = new URL(call.url)
    assert.equal(url.origin, BASE)
    assert.equal(url.pathname.startsWith(REFERRAL_SHARE_PREFIX), false, "本模块不抓 /r/<code>")
    assert.equal(call.url.includes("bind"), false, "永不 bind")
    assert.equal(call.url.includes("activities"), false, "不碰推理端点")
    assert.equal(call.url.includes("inference"), false, "不碰推理端点")
    // 被调用的只有带 Bearer 的 API；分享页根本不在这条链上
    assert.equal(call.init.headers.authorization, "Bearer access-test")
  }

  // 派生出来的 share_url 只是字符串，没有产生请求
  assert.equal(calls.length, 2)
  assert.equal(res.shareUrl, `${BASE}/r/${CODE_1}`)
})

test("常量：端点与空 body 字面量固定", () => {
  assert.equal(REFERRAL_ME_PATH, "/api/oauth/referrals/me")
  assert.equal(REFERRAL_CODE_PATH, "/api/oauth/referrals/code")
  assert.deepEqual(REFERRAL_CODE_BODY, {})
  assert.equal(Object.isFrozen(REFERRAL_CODE_BODY), true, "空 body 必须冻结，别被调用方改出别的 canonical")
})
