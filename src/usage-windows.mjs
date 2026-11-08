// src/usage-windows.mjs —— 额度卡片的数据面
//
// 为什么单独一个文件（AGENTS 坑 18）：入口 `index.mjs` 只做九钩子装配，
// 实现搬进 `src/`。
//
// ══ 卡片长什么样（2026-11-09 按官方客户端「用量」页对齐）══
//
//   积分余额    2,596 / 2,600 · 任务预留 3 · 2,595 将于 12月8日 到期
//   套餐        体验版 · 至 2026年12月8日
//
// 就这两行。曾经有五条（5 小时 / 7 天 / 套餐额度 / 体验版 / 每日登录奖励），
// 全部删掉，理由分三类：
//
//   ① **官方明确说没有独立窗口**：「当前套餐使用单一个月度积分池，
//      不设置独立的 5 小时或 7 天额度。」—— 官方客户端「用量」页
//   ② **来源明细不是额度**：体验版 / 每日登录奖励是钱包的**构成**，加起来就是总额，
//      分开列只会让 magpie 的窄卡片挤成一团，还会让路由重复计权
//   ③ **「临期积分」不能单独当窗口** —— 这条最要命：
//      它的 `amount` 和 `limit` 都是「即将到期的余额」，算出来 `used = 100%`，
//      等于告诉 magpie「这个账号已经用光了」，路由会直接把它排到最后甚至跳过。
//      临期是**时间属性**，必须挂在唯一那条可路由的窗口上（`runsOutAt` / `runsOut`），
//      不能自立门户（AGENTS 坑 23）。
//
// 数据来源（全部实测，见 `scripts/probe-endpoints.mjs`）：
//   GET /api/oauth/usage/summary  → plan:{ name, expires_at }
//   GET /api/work/rewards?limit=5 → wallet:{ availablePoints, totalPoints, reservedPoints,
//                                          expiringWithin30Days, nextExpiry }
//   GET /api/oauth/usage          → extra_usage（套餐外额度，未启用时整条不出）

import { fetchUsage as fetchCloudUsage, fetchUsageSummary, fetchWallet } from "./phanthy-api.mjs"
import { toIso, usage as buildUsage, usageWindow } from "./quota.mjs"

/** 官方活动 / 套餐时间都用 UTC+8 换日（与 src/activity.mjs 同一口径） */
export const PLAN_TZ_OFFSET = "+08:00"

/** 逐条格式化积分（千分位；非数字原样转字符串，不编造 0） */
export function formatPoints(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value ?? "")
  return n.toLocaleString("zh-CN")
}

/** 取第一个有限数字（字段可能缺席，不把缺席当 0） */
function finiteOf(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** 只显示日期（官方钱包也是只给日期，不带时分秒） */
function dayOf(iso) {
  try {
    return new Date(iso).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })
  } catch {
    return String(iso ?? "")
  }
}

/**
 * 组装 `usage()` 的返回值。
 *
 * @param {{auth: object, fetchImpl?: Function}} options
 * @returns {Promise<object>} 可直接交给 magpie 的 usage 对象（或 `{error, windows: []}`）
 */
export async function buildUsageReport({ auth, fetchImpl } = {}) {
  const [usageResult, walletResult, summaryResult] = await Promise.allSettled([
    fetchCloudUsage(auth, { fetchImpl }),
    fetchWallet(auth, { fetchImpl }),
    fetchUsageSummary(auth, { fetchImpl }),
  ])

  // 三个数据面全挂才算失败（任一成功都要把能显示的那部分给用户）
  const allFailed =
    usageResult.status === "rejected" &&
    walletResult.status === "rejected" &&
    summaryResult.status === "rejected"
  if (allFailed) throw usageResult.reason

  const usageBody = usageResult.status === "fulfilled" ? usageResult.value : null
  const walletBody = walletResult.status === "fulfilled" ? walletResult.value : null
  const summaryBody = summaryResult.status === "fulfilled" ? summaryResult.value : null

  const wallet = walletBody?.wallet ?? null
  // ⚠ camelCase：真实响应就是 `availablePoints` / `totalPoints`（见文件头三条更正）
  const available = finiteOf(wallet?.availablePoints, wallet?.available_points)
  const total = finiteOf(wallet?.totalPoints, wallet?.total_points)
  const reserved = finiteOf(wallet?.reservedPoints, wallet?.reserved_points)

  // 临期：官方字段 `expiringWithin30Days` + `nextExpiry`。
  // ⚠ 它**不是**独立窗口（原因见文件头 ③）—— 只是钱包窗口上的两个属性。
  const expiring = finiteOf(wallet?.expiringWithin30Days, wallet?.expiring_within_30_days)
  const nextExpiryRaw = wallet?.nextExpiry ?? wallet?.next_expiry
  // 坑 33：无 zone 的时间必须先给显式 offset，否则 CI（UTC）与本地（+08:00）差 8 小时
  const runsOutAt = nextExpiryRaw ? toIso(nextExpiryRaw, "runsOutAt", { offset: PLAN_TZ_OFFSET }) : undefined
  const hasExpiring = expiring !== undefined && expiring > 0 && Boolean(runsOutAt)

  const windows = []

  // ① 积分余额 —— 卡片上唯一可路由的那一条。
  //    临期信息挂在这里（`runsOutAt` / `runsOut`），magpie 的「到期前用完」路由才有输入。
  if (available !== undefined && total !== undefined && total > 0) {
    const notes = []
    if (reserved !== undefined && reserved > 0) notes.push(`任务预留 ${formatPoints(reserved)}`)
    if (hasExpiring) notes.push(`${formatPoints(expiring)} 将于 ${dayOf(runsOutAt)} 到期`)
    windows.push(
      usageWindow({
        name: "积分余额",
        amount: Math.max(0, total - available),
        limit: total,
        unit: "积分",
        display: [`${formatPoints(available)} / ${formatPoints(total)}`, ...notes].join(" · "),
        ...(hasExpiring ? { runsOutAt, runsOut: expiring } : {}),
      }),
    )
  } else if (available !== undefined) {
    // 钱包型：只有余额、没有上限 —— 卡片照常显示余额
    windows.push(
      usageWindow({
        name: "积分余额",
        balance: available,
        unit: "积分",
        display: formatPoints(available),
        ...(hasExpiring ? { runsOutAt, runsOut: expiring } : {}),
      }),
    )
  }

  // ② 套餐外额度：只有上限、没有已用 → textOnly（不拿上限当分母算出「剩余 100%」）
  const extraEnabled = usageBody?.extra_usage?.is_enabled === true
  const monthlyLimit = finiteOf(usageBody?.extra_usage?.monthly_limit)
  if (extraEnabled && monthlyLimit !== undefined && monthlyLimit > 0) {
    windows.push(
      usageWindow({ name: "套餐外额度", textOnly: true, display: `上限 ${formatPoints(monthlyLimit)} 积分` }),
    )
  }

  // ③ 套餐名：来自 usage/summary 的 `plan`，不是 usage 本体
  const planName = String(summaryBody?.plan?.name ?? "").trim()
  const planExpires = summaryBody?.plan?.expires_at

  if (planName) {
    windows.push(
      usageWindow({
        name: "套餐",
        textOnly: true,
        display: `${planName}${planExpires ? ` · 至 ${dayOf(planExpires)}` : ""}`,
      }),
    )
  }

  if (windows.length === 0) {
    return { error: "额度接口没有返回可用的余额数据", windows: [] }
  }

  // 有一条可路由的窗口（带 used 或 balance）就够；一条都没有时路由页会显示「剩余额度未知」
  const routable = windows.filter((w) => w.aside !== true && (w.used !== undefined || w.balance !== undefined))
  if (routable.length === 0) {
    return {
      error: "额度接口只给了套餐信息，没有积分余额（该账号在智能路由里没有额度读数）",
      windows,
    }
  }

  return buildUsage({
    plan: planName || undefined,
    until: planExpires ? toIso(planExpires, "until", { offset: PLAN_TZ_OFFSET }) : undefined,
    windows,
  })
}
