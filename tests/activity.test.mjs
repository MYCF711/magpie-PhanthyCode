// tests/activity.test.mjs —— 签到/奖励：执行级 mock（不联网、不读真实凭据）
import test from "node:test"
import assert from "node:assert/strict"

import {
  ACTIVITY_TZ_OFFSET_MINUTES,
  DAILY_CLAIM_PATH,
  claimIdempotencyKey,
  classifyClaim,
  createDailyActivity,
  createSingleFlight,
  dailyLoginGranted,
  dailyLoginReward,
  dailyLoginStreak,
  dayKeyOf,
  readRewards,
  rewardsPath,
} from "../src/activity.mjs"

const ID = "inst_test_0001"
const AUTH = { access: "test-access-token", metadata: { openid: "o_test", guid: "g_test" } }
const SIGN = (canonical) => `sig(${canonical.length})`
const INSTALL = { installationId: ID, sign: SIGN }
const NOW = Date.parse("2026-11-08T02:00:00Z") // UTC+8 = 10:00，日键 2026-11-08

function recorder(responses) {
  const calls = []
  const request = async (options) => {
    calls.push(options)
    const next = responses.shift()
    if (typeof next === "function") return next(options)
    return next ?? { status: 200, body: {} }
  }
  return { request, calls }
}

test("dayKeyOf：按 UTC+8 换日，不跟随本机时区", () => {
  assert.equal(dayKeyOf(NOW), "2026-11-08")
  // UTC 16:00 = 次日 00:00（+8）
  assert.equal(dayKeyOf(Date.parse("2026-11-08T16:00:00Z")), "2026-11-09")
  assert.equal(dayKeyOf(NOW, 0), "2026-11-08")
  assert.equal(ACTIVITY_TZ_OFFSET_MINUTES, 480)
})

test("claimIdempotencyKey：同账号同日固定，缺字段直接抛", () => {
  assert.equal(claimIdempotencyKey(ID, "2026-11-08"), "daily:inst_test_0001:2026-11-08")
  assert.throws(() => claimIdempotencyKey("", "2026-11-08"), /installationId/)
  assert.throws(() => claimIdempotencyKey(ID, "2026/11/08"), /YYYY-MM-DD/)
})

test("rewardsPath：保留前端用的 type=daily_login", () => {
  assert.equal(rewardsPath(), "/api/oauth/rewards?type=daily_login")
})

test("readRewards：只读已出现过的字段，账单缺失时为 null", () => {
  const value = readRewards({
    wallet: { availablePoints: 120, totalPoints: 500, balancePoints: 100 },
    campaigns: [{ totalPoints: 30 }, { totalPoints: 40 }],
  })
  assert.equal(value.availablePoints, 120)
  assert.equal(value.balancePoints, 100)
  assert.equal(value.campaignTotal, 70)
  assert.equal(value.bills, null)
  assert.equal(readRewards(null).availablePoints, null)
})

test("readRewards：daily.server_date 是官方领取幂等键的日期来源（@109912）", () => {
  assert.equal(readRewards({ daily: { server_date: "2026-11-09" } }).serverDate, "2026-11-09")
  // 形状不对就不采信，交给调用方退回本地日键
  assert.equal(readRewards({ daily: { server_date: "2026/11/09" } }).serverDate, "")
  assert.equal(readRewards({}).serverDate, "")
})

test("claim 幂等键优先用服务端 server_date（跨日窗口不会多 POST 一次）", async () => {
  const { request, calls } = recorder([
    // 本机算出的是 2026-11-08，但服务端说今天是 2026-11-09（跨日窗口 / 时区差异）
    { status: 200, body: { wallet: { availablePoints: 100 }, daily: { server_date: "2026-11-09" } } },
    { status: 200, body: {} },
    { status: 200, body: { wallet: { availablePoints: 100 } } },
  ])
  const daily = createDailyActivity({ request, now: () => NOW })
  const result = await daily.claim(AUTH, INSTALL)
  assert.equal(result.outcome, "claimed")
  const claimCall = calls.find((c) => c.path === DAILY_CLAIM_PATH)
  assert.equal(claimCall.sign.idempotencyKey, "daily:inst_test_0001:2026-11-09")
  assert.equal(result.dayKey, "2026-11-09")
})

test("classifyClaim：409=已领、401=登录态、402/403 如实分流", () => {
  assert.equal(classifyClaim({ status: 200 }).outcome, "claimed")
  assert.equal(classifyClaim({ status: 201 }).outcome, "claimed")
  assert.equal(classifyClaim({ status: 409, body: { error: { code: "already_claimed" } } }).outcome, "done")
  assert.equal(classifyClaim({ status: 401 }).outcome, "signIn")
  assert.equal(classifyClaim({ status: 402 }).outcome, "insufficient")
  assert.equal(classifyClaim({ status: 403 }).outcome, "forbidden")
  assert.equal(classifyClaim({ status: 500 }).outcome, "failed")
})

test("未注册设备：status/claim 都不发请求", async () => {
  const { request, calls } = recorder([])
  const daily = createDailyActivity({ request, now: () => NOW })
  assert.equal((await daily.status(AUTH, null)).reason, "device_not_registered")
  assert.equal((await daily.claim(AUTH, null)).reason, "device_not_registered")
  assert.equal(calls.length, 0)
})

test("claim：POST 空对象 + daily:<id>:<day> 幂等键 + 签名头参数", async () => {
  const { request, calls } = recorder([
    { status: 200, body: { wallet: { availablePoints: 100 } } }, // before
    { status: 200, body: {} }, // claim
    { status: 200, body: { wallet: { availablePoints: 130 } } }, // after
  ])
  const daily = createDailyActivity({ request, now: () => NOW })
  const result = await daily.claim(AUTH, INSTALL)

  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 30)
  const claimCall = calls.find((c) => c.path === DAILY_CLAIM_PATH)
  assert.ok(claimCall, "必须命中领取端点")
  assert.equal(claimCall.method, "POST")
  assert.deepEqual(claimCall.body, {})
  assert.equal(claimCall.sign.idempotencyKey, "daily:inst_test_0001:2026-11-08")
  assert.equal(claimCall.sign.installationId, ID)
  assert.equal(claimCall.auth, AUTH)
})

test("同一天两次领取：幂等键完全相同（不会产生第二条）", async () => {
  const keys = []
  const request = async (options) => {
    if (options.path === DAILY_CLAIM_PATH) keys.push(options.sign.idempotencyKey)
    return { status: 200, body: { wallet: { availablePoints: 100 } } }
  }
  const daily = createDailyActivity({ request, now: () => NOW })
  await daily.claim(AUTH, INSTALL)
  await daily.claim(AUTH, INSTALL)
  assert.deepEqual(keys, ["daily:inst_test_0001:2026-11-08", "daily:inst_test_0001:2026-11-08"])
})

test("并发领取：同 key 单飞，只发一次 POST", async () => {
  let posts = 0
  const request = async (options) => {
    if (options.path === DAILY_CLAIM_PATH) {
      posts += 1
      await new Promise((r) => setTimeout(r, 10))
    }
    return { status: 200, body: { wallet: { availablePoints: 100 } } }
  }
  const daily = createDailyActivity({ request, now: () => NOW, flight: createSingleFlight() })
  const [a, b] = await Promise.all([daily.claim(AUTH, INSTALL), daily.claim(AUTH, INSTALL)])
  assert.equal(posts, 1)
  assert.equal(a.outcome, "claimed")
  assert.equal(b.outcome, "claimed")
})

test("409：当日已领，返回 done 而不是失败", async () => {
  const { request } = recorder([
    { status: 200, body: { wallet: { availablePoints: 100 } } },
    { status: 409, body: { error: { code: "already_claimed", message: "already" } } },
  ])
  const daily = createDailyActivity({ request, now: () => NOW })
  const result = await daily.claim(AUTH, INSTALL)
  assert.equal(result.outcome, "done")
  assert.equal(result.code, "already_claimed")
})

test("401：交给调用方按登录失效处理，不当成签到失败", async () => {
  const { request } = recorder([
    { status: 200, body: { wallet: { availablePoints: 100 } } },
    { status: 401, body: { error: { code: "unauthorized" } } },
  ])
  const daily = createDailyActivity({ request, now: () => NOW })
  assert.equal((await daily.claim(AUTH, INSTALL)).outcome, "signIn")
})

test("账单差集：有 bills 时只算新增积分", async () => {
  const { request } = recorder([
    { status: 200, body: { bills: [{ bill_id: "b1", points: 10 }] } },
    { status: 200, body: {} },
    { status: 200, body: { bills: [{ bill_id: "b1", points: 10 }, { bill_id: "b2", points: 25 }] } },
  ])
  const daily = createDailyActivity({ request, now: () => NOW })
  const result = await daily.claim(AUTH, INSTALL)
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 25)
})

// ── 签到「已签」的语义：credit / streak 必须给出去 ──────────────────────
//
// 为什么不给就是错的（2026-11-09 真机）：`outcome: "done"` 但 credit=0 时，
// magpie 只能渲染成黄灯「回复已签到，但它的签到日可能…」；同一个账号在别的
// 插件里是绿灯「今日已签到 +100 · 连续 41 天」。

/** 造一条 daily_login 奖励 */
const reward = (grantedAt, { status = "granted", points = 300, reasonCode = "daily_login" } = {}) => ({
  reasonCode,
  status,
  points,
  grantedAt,
})

test("dailyLoginReward：今天那条 daily_login 奖励（带 points）", () => {
  // NOW = 2026-11-08T02:00:00Z ⇒ UTC+8 是 2026-11-08 10:00，日键 2026-11-08
  // 12:34Z ⇒ +08 20:34 ⇒ 今天；16:30Z ⇒ +08 次日 00:30 ⇒ 不是今天
  const bills = [reward("2026-11-08T16:30:33.375Z"), reward("2026-11-08T12:34:28.681Z")]
  const today = dailyLoginReward({ bills }, { now: () => NOW })
  assert.equal(today?.points, 300, "12:34Z 那条属于今天")

  const onlyTomorrow = dailyLoginReward({ bills: [reward("2026-11-08T16:30:33.375Z")] }, { now: () => NOW })
  assert.equal(onlyTomorrow, null, "16:30Z 在 +08 已经是次日，不算今天")
})

test("dailyLoginReward：未发放 / 别的 reasonCode 都不算", () => {
  assert.equal(dailyLoginReward({ bills: [reward("2026-11-07T16:30:00.000Z", { status: "pending" })] }, { now: () => NOW }), null)
  assert.equal(
    dailyLoginReward({ bills: [reward("2026-11-07T16:30:00.000Z", { reasonCode: "referral" })] }, { now: () => NOW }),
    null,
  )
})

test("dailyLoginReward：兼容上游原始的 rewards 数组（不是 {bills}）", () => {
  const arr = [reward("2026-11-07T16:30:00.000Z")]
  assert.equal(dailyLoginReward(arr, { now: () => NOW })?.points, 300, "数组形状也要认")
})

test("dailyLoginGranted 就是 dailyLoginReward 的布尔化（同一份判据）", () => {
  const yes = { bills: [reward("2026-11-07T16:30:00.000Z")] }
  const no = { bills: [reward("2026-11-07T16:30:00.000Z", { status: "pending" })] }
  assert.equal(dailyLoginGranted(yes, { now: () => NOW }), true)
  assert.equal(dailyLoginGranted(no, { now: () => NOW }), false)
})

test("dailyLoginStreak：连续天数从今天往回数", () => {
  const DAY = 86_400_000
  // 今天 + 前两天（+08 的 00:30 换日）
  const bills = [0, 1, 2].map((i) => reward(new Date(NOW - i * DAY).toISOString()))
  assert.equal(dailyLoginStreak({ bills }, { now: () => NOW }), 3)
})

test("dailyLoginStreak：断一天就只算到断点", () => {
  const DAY = 86_400_000
  const bills = [0, 1, 3].map((i) => reward(new Date(NOW - i * DAY).toISOString()))
  assert.equal(dailyLoginStreak({ bills }, { now: () => NOW }), 2, "第 3 天缺席 ⇒ 连续只有 2")
})

test("dailyLoginStreak：今天还没签时从昨天数，不归零", () => {
  const DAY = 86_400_000
  const bills = [1, 2].map((i) => reward(new Date(NOW - i * DAY).toISOString()))
  assert.equal(dailyLoginStreak({ bills }, { now: () => NOW }), 2, "过了 0 点还没签，连续天数不能清零")
})

test("dailyLoginStreak：没有任何奖励 → 0（调用方不要给 magpie 传 0）", () => {
  assert.equal(dailyLoginStreak({ bills: [] }, { now: () => NOW }), 0)
  assert.equal(dailyLoginStreak({}, { now: () => NOW }), 0)
  assert.equal(dailyLoginStreak(undefined, { now: () => NOW }), 0)
})