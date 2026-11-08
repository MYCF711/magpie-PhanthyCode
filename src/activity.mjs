// src/activity.mjs —— 每日签到 / 活动 / 奖励（纯逻辑 + 可注入请求层）
//
// 静态证据（`_up_\dist\assets\App-Y9eSJNhB.js`，前端 `Co()` 的调用表）：
//   · 领取：POST {base}/api/oauth/activities/daily-login/claim，body 是 `{}`，
//     幂等键 `daily:<installationId>:<t>`，带 v1 签名头（x-desktop-installation-id/-timestamp/
//     -nonce/-signature + idempotency-key），Authorization 用账号 access token。
//   · 奖励：GET {base}/api/oauth/rewards，本地路径带 `?type=daily_login`，同样是签名请求。
//   · 钱包字段：`wallet{availablePoints,totalPoints,balancePoints,reservedPoints}`。
//   · 同文件里 onboarding / 推荐码各自的幂等键：`onboarding:start:<id>:<task>`、
//     `onboarding:complete:<id>:<task>`、`referral-code:<id>`——本模块只处理签到，其余不外发。
//
// 规矩：
//   ① 默认**不领取**。`claim()` 只有显式调用才会发请求；`status()` 只读。
//   ② 幂等键按「账号的 installationId + 当地日」固定；同一天重复调用只会命中同一条。
//   ③ 结果判定优先用账单差集（before/after），拿不到账单时退回钱包可用额差；
//      两者都没有就保守返回 done，不把历史奖励算成新的。
//   ④ 402/403 如实映射为 failed + code，绝不改写成 401（那会打死整个账号）。

import { reconcileCheckin } from "./checkin.mjs"

/** 领取端点（POST，body `{}`） */
export const DAILY_CLAIM_PATH = "/api/oauth/activities/daily-login/claim"

/** 奖励端点（GET） */
export const REWARDS_PATH = "/api/oauth/rewards"

/** 前端给本地路径带的查询串（沿用它的意图：只看每日登录类奖励） */
export const REWARDS_DAILY_QUERY = "?type=daily_login"

/** 领取请求体：上游要的是空对象字面量，不是空串 */
export const CLAIM_BODY = {}

/** 时区偏移（分钟）：官方活动按 UTC+8 换日 */
export const ACTIVITY_TZ_OFFSET_MINUTES = 480

/**
 * 当地日键（YYYY-MM-DD）。跨时区换日必须以官方时区为准，
 * 用本机时区会在 0 点前后把同一天算成两天、发出第二条幂等键。
 */
export function dayKeyOf(now = Date.now(), offsetMinutes = ACTIVITY_TZ_OFFSET_MINUTES) {
  const shifted = new Date(Number(now) + Number(offsetMinutes) * 60_000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0")
  const d = String(shifted.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** 领取幂等键：`daily:<installationId>:<dayKey>`（与官方前端同形） */
export function claimIdempotencyKey(installationId, dayKey) {
  const id = String(installationId ?? "").trim()
  const day = String(dayKey ?? "").trim()
  if (!id) throw new TypeError("claimIdempotencyKey: installationId 必须是非空字符串")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError("claimIdempotencyKey: dayKey 必须是 YYYY-MM-DD")
  return `daily:${id}:${day}`
}

/** 奖励请求路径（带查询串） */
export function rewardsPath() {
  return `${REWARDS_PATH}${REWARDS_DAILY_QUERY}`
}

/**
 * 从 rewards 响应里取可核对的信息。上游字段形状没有公开契约，
 * 所以这里只读**已在前端出现过的字段**，其余一律不猜：
 *   wallet.availablePoints / totalPoints / balancePoints、campaigns[].totalPoints。
 * 账单数组只在响应里确实有 `bills/items/rewards` 时才用。
 *
 * `daily.server_date`（YYYY-MM-DD）：官方前端的领取幂等键用的是**这个日期**，
 * 不是本机算出来的日键（`App-Y9eSJNhB.js` @109912 `wo.claim(r, a.daily.server_date)`）。
 * 取不到才退回本地 UTC+8 日键。
 */
export function readRewards(body) {
  const value = body && typeof body === "object" ? body : {}
  const wallet = value.wallet && typeof value.wallet === "object" ? value.wallet : {}
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
  const campaigns = Array.isArray(value.campaigns) ? value.campaigns : []
  const campaignTotal = campaigns.reduce((sum, c) => sum + (num(c?.totalPoints) ?? 0), 0)
  const listed = Array.isArray(value.bills) ? value.bills : Array.isArray(value.items) ? value.items : Array.isArray(value.rewards) ? value.rewards : null
  const daily = value.daily && typeof value.daily === "object" ? value.daily : {}
  const serverDate = /^\d{4}-\d{2}-\d{2}$/.test(String(daily.server_date ?? "")) ? String(daily.server_date) : ""
  return {
    availablePoints: num(wallet.availablePoints),
    totalPoints: num(wallet.totalPoints),
    balancePoints: num(wallet.balancePoints),
    campaignTotal,
    bills: listed,
    serverDate,
    raw: value,
  }
}

/**
 * 今天是否**已经领过**每日登录奖励。
 *
 * 为什么需要：`auth.checkin` 在「自动领取关闭」时只读状态。早期实现不管读到什么都
 * 返回 `outcome: "failed"` —— 但「没开自动领取」不是失败，而官方客户端往往**已经领过**
 * 了（桌面端启动就会 claim）。报 failed 会让宿主以为签到坏了。
 *
 * 判据（只看 rewards 数组里已出现过的字段，不猜）：
 *   reasonCode === "daily_login" 且 status === "granted"，且 grantedAt 落在今天
 *   今天按 `offsetMinutes`（默认 +08:00）换日 —— 与 claim 的幂等键同口径。
 *
 * @param {{bills?: any[]|null, serverDate?: string}} rewards `readRewards()` 的返回值
 * @param {{now?: () => number, offsetMinutes?: number}} [options]
 * @returns {boolean} 无法判定时返回 false（保守：不谎报已签）
 */
/**
 * 今天那条 `daily_login` 奖励（没有就返回 null）。
 *
 * 为什么要返回整个对象而不只是布尔：`auth.checkin` 的 `done` 分支必须告诉 magpie
 * **给了多少积分**（`credit`），否则卡片只能显示黄灯「回复已签到，但它的签到日可能…」
 * 而不是「今日已签到 +300 · 连续 N 天」（2026-11-09 真机对照另一个插件的绿灯）。
 *
 * 兼容两种入参形状：
 *   · `{ bills: [...] }` —— `createDailyActivity.status()` 归一化后的形状
 *   · `[...]`            —— 上游 `/api/work/rewards` 原始的 `rewards` 数组
 */
export function dailyLoginReward(rewards, { now = Date.now, offsetMinutes = 480 } = {}) {
  const bills = Array.isArray(rewards) ? rewards : Array.isArray(rewards?.bills) ? rewards.bills : []
  if (bills.length === 0) return null
  const today = rewards?.serverDate || dayKeyOf(now(), offsetMinutes)
  for (const bill of bills) {
    if (!bill || typeof bill !== "object") continue
    const reason = String(bill.reasonCode ?? bill.reason_code ?? "")
    if (reason !== "daily_login") continue
    if (String(bill.status ?? "") !== "granted") continue
    const at = bill.grantedAt ?? bill.granted_at ?? ""
    if (!at) continue
    const ms = Date.parse(String(at))
    if (!Number.isFinite(ms)) continue
    if (dayKeyOf(ms, offsetMinutes) === today) return bill
  }
  return null
}

/**
 * 连续签到天数：从今天往回数，`daily_login` 奖励日连续不断的那一段长度。
 *
 * ⚠ 只能数**拿得到的那些**。上游一次最多给几条，数不满就返回实际能数的值 ——
 *   不拿「账号注册天数」之类的东西凑数（那是编造）。数到 0 返回 0，
 *   调用方**不要**给 magpie 传 0（`num()` 会把它当「没有」）。
 */
export function dailyLoginStreak(rewards, { now = Date.now, offsetMinutes = 480 } = {}) {
  const bills = Array.isArray(rewards) ? rewards : Array.isArray(rewards?.bills) ? rewards.bills : []
  if (bills.length === 0) return 0

  /** 有 `daily_login` 且已发放的日子（YYYY-MM-DD，官方时区） */
  const days = new Set()
  for (const bill of bills) {
    if (!bill || typeof bill !== "object") continue
    if (String(bill.reasonCode ?? bill.reason_code ?? "") !== "daily_login") continue
    if (String(bill.status ?? "") !== "granted") continue
    const ms = Date.parse(String(bill.grantedAt ?? bill.granted_at ?? ""))
    if (!Number.isFinite(ms)) continue
    days.add(dayKeyOf(ms, offsetMinutes))
  }
  if (days.size === 0) return 0

  const DAY = 86_400_000
  const base = now()
  // 今天签了就今天开始数；今天还没签（比如刚过 0 点）就从昨天开始数，
  // 这样「连续 41 天」不会因为跨了一次午夜就归零。
  const from = days.has(dayKeyOf(base, offsetMinutes)) ? 0 : 1
  let streak = 0
  while (days.has(dayKeyOf(base - DAY * (from + streak), offsetMinutes))) streak++
  return streak
}

/** 今天是否已经领过 `daily_login` 奖励 */
export function dailyLoginGranted(rewards, options) {
  return dailyLoginReward(rewards, options) !== null
}

/**
 * 领取结果的语义映射（只看状态码 + 上游 code，不读文案）：
 *   200/201 → claimed；409 → done（今天已经领过）
 *   401 → signIn（调用方抛 signIn expired）；402 → insufficient；403 → forbidden
 */
export function classifyClaim({ status, body } = {}) {
  const code = String(body?.error?.code ?? body?.code ?? "")
  const message = String(body?.error?.message ?? body?.message ?? "")
  const s = Number(status)
  if (s === 200 || s === 201) return { outcome: "claimed", status: s, code, message }
  if (s === 409) return { outcome: "done", status: s, code, message }
  if (s === 401) return { outcome: "signIn", status: s, code, message }
  if (s === 402) return { outcome: "insufficient", status: s, code, message }
  if (s === 403) return { outcome: "forbidden", status: s, code, message }
  return { outcome: "failed", status: s, code, message }
}

/** 简单单飞：同 key 并发只跑一次，完成后释放（不缓存成功结果） */
export function createSingleFlight() {
  const inFlight = new Map()
  return {
    run(key, fn) {
      const k = String(key)
      if (inFlight.has(k)) return inFlight.get(k)
      const p = Promise.resolve()
        .then(fn)
        .finally(() => inFlight.delete(k))
      inFlight.set(k, p)
      return p
    },
    get size() {
      return inFlight.size
    },
  }
}

/**
 * 每日活动客户端。`request` 复用 src/phanthy-api.mjs 的签名请求层：
 *   request({ path, method, auth, body, sign: { installationId, sign, idempotencyKey } })
 *
 * @param {object} deps
 * @param {Function} deps.request
 * @param {() => number} [deps.now]
 * @param {number} [deps.offsetMinutes]
 * @param {ReturnType<typeof createSingleFlight>} [deps.flight]
 */
export function createDailyActivity({
  request,
  now = () => Date.now(),
  offsetMinutes = ACTIVITY_TZ_OFFSET_MINUTES,
  flight = createSingleFlight(),
} = {}) {
  if (typeof request !== "function") throw new TypeError("createDailyActivity: request 必须是函数")

  function signOf(installation, idempotencyKey) {
    if (!installation?.installationId) return null
    if (typeof installation.sign !== "function") return null
    return { installationId: String(installation.installationId), sign: installation.sign, idempotencyKey }
  }

  /** 只读状态：拿不到设备身份就不发请求（活动接口全要 v1 签名） */
  async function status(auth, installation) {
    const sign = signOf(installation, `status:${installation?.installationId ?? ""}:${dayKeyOf(now(), offsetMinutes)}`)
    if (!sign) return { outcome: "inactive", reason: "device_not_registered", rewards: null }
    try {
      const res = await request({ path: rewardsPath(), method: "GET", auth, sign })
      const rewards = readRewards(res.body)
      return { outcome: "ok", rewards, status: res.status }
    } catch (error) {
      return { outcome: "failed", reason: String(error?.code ?? error?.name ?? "error"), message: String(error?.message ?? "") }
    }
  }

  /**
   * 领取一次。只有显式调用才会执行；同一天重复调用不会产生第二条幂等键。
   * 返回 claimed/done/inactive/failed；401 交给调用方抛 signIn。
   */
  async function claim(auth, installation) {
    if (!installation?.installationId) return { outcome: "inactive", reason: "device_not_registered" }
    const localDayKey = dayKeyOf(now(), offsetMinutes)
    const localSign = signOf(installation, claimIdempotencyKey(installation.installationId, localDayKey))
    if (!localSign) return { outcome: "inactive", reason: "device_not_registered" }

    return flight.run(localSign.idempotencyKey, async () => {
      const before = await status(auth, installation)
      // 幂等键的日期优先用服务端的 `daily.server_date`（官方前端就是这么做的）：
      // 跨日窗口 / 时区差异时，本地日键会比服务端早或晚一天，导致多 POST 一次。
      const dayKey = before?.rewards?.serverDate || localDayKey
      const sign = dayKey === localDayKey
        ? localSign
        : signOf(installation, claimIdempotencyKey(installation.installationId, dayKey))
      const res = await request({
        path: DAILY_CLAIM_PATH,
        method: "POST",
        auth,
        body: CLAIM_BODY,
        sign,
      }).catch((error) => ({ status: Number(error?.status ?? 0), body: { error: { code: error?.code, message: error?.message } } }))

      const verdict = classifyClaim(res)
      if (verdict.outcome === "signIn") return verdict
      if (verdict.outcome !== "claimed") return { ...verdict, dayKey }

      const after = await status(auth, installation)
      const beforeBills = before?.rewards?.bills ?? null
      const afterBills = after?.rewards?.bills ?? null
      let credit = 0
      let message = ""
      if (afterBills && beforeBills) {
        const diff = reconcileCheckin({ before: beforeBills, after: afterBills, pointsOf: (b) => b?.points ?? b?.amount })
        credit = diff.credit
        message = diff.message
      } else if (Number.isFinite(after?.rewards?.availablePoints) && Number.isFinite(before?.rewards?.availablePoints)) {
        credit = Math.max(0, after.rewards.availablePoints - before.rewards.availablePoints)
        message = credit > 0 ? `今日签到 +${credit}` : "已领取"
      } else {
        message = "已领取（上游未给可核对的账单）"
      }
      return { outcome: "claimed", dayKey, credit, message, status: verdict.status }
    })
  }

  return { status, claim, dayKey: () => dayKeyOf(now(), offsetMinutes) }
}
