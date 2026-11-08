/**
 * 生成账单的去重键，优先使用稳定 ID，缺失时退化为账单内容指纹
 * @param {Record<string, unknown> | null | undefined} item
 * @returns {string}
 */
export function billKey(item) {
  return String(item?.bill_id || item?.biz_id || `${item?.created_at ?? ''}:${item?.points ?? 0}:${item?.event_name ?? ''}`)
}

/**
 * 将厂商账单积分归一化为非负整数
 * @param {unknown} value
 * @returns {number}
 */
function positivePoints(value) {
  return Math.max(0, Math.floor(Number(value) || 0))
}

/**
 * 判断账单是否发放了正积分，不判断日期或厂商业务类型
 * @param {Record<string, unknown> | null | undefined} item
 * @returns {boolean}
 */
export function isPositiveGrant(item) {
  return positivePoints(item?.points) > 0
}

/**
 * 对账签到前后的账单，不发起请求，也不包含任何厂商登录或 API 逻辑
 *
 * 重要：before 与 after 必须已由调用方过滤为本次签到时间范围内、与签到或奖励相关的账单。
 * 本函数不识别日期和业务类型，也不会剔除 after 中凭空出现的历史账单。
 * before 为 null 或 undefined 表示前快照缺失，此时保守返回 done，避免把历史账单算作新奖励。
 * 但本次调用已实际获得的 extraCredit 仍可单独报告为 claimed。
 *
 * @param {object} options
 * @param {Array<Record<string, unknown>> | null | undefined} options.before 已过滤的签到前账单
 * @param {Array<Record<string, unknown>> | null | undefined} options.after 已过滤的签到后账单
 * @param {(item: Record<string, unknown>) => unknown} [options.keyOf=billKey] 账单去重键函数
 * @param {(item: Record<string, unknown>) => unknown} [options.pointsOf] 积分读取函数，默认读取 points
 * @param {number} [options.extraCredit=0] 本次已实际获得、但尚未确定是否入账的一次性奖励
 * @param {string} [options.extraName='额外奖励'] 一次性奖励的显示名
 * @param {(item: Record<string, unknown>) => boolean} [options.hasRewardBill] 判断新账单是否已包含一次性奖励
 * @returns {{outcome: 'claimed' | 'done', credit: number, message: string, names?: string[], hasNewRewardBill?: boolean}}
 */
export function reconcileCheckin({
  before,
  after,
  keyOf = billKey,
  pointsOf = item => item?.points,
  extraCredit = 0,
  extraName = '额外奖励',
  hasRewardBill = item => String(item?.biz_type ?? '') === 'reward_grant'
}) {
  const extra = positivePoints(extraCredit)

  if (before == null) {
    if (extra > 0) {
      return {
        outcome: 'claimed',
        credit: extra,
        message: `${extraName} +${extra}`,
        names: [extraName]
      }
    }
    return { outcome: 'done', credit: 0, message: '今日已签到' }
  }

  const seen = new Set((Array.isArray(before) ? before : []).map(item => String(keyOf(item))))
  const names = []
  let credit = 0
  let hasNewRewardBill = false

  for (const item of Array.isArray(after) ? after : []) {
    const points = positivePoints(pointsOf(item))
    if (points <= 0) continue

    const key = String(keyOf(item))
    if (seen.has(key)) continue
    seen.add(key)

    credit += points
    if (hasRewardBill(item)) hasNewRewardBill = true

    const name = String(item?.event_name || '积分发放')
    if (!names.includes(name)) names.push(name)
  }

  // 新 reward_grant 已包含一次性奖励时，不再叠加 extraCredit
  if (extra > 0 && !hasNewRewardBill) {
    credit += extra
    if (!names.includes(extraName)) names.push(extraName)
  }

  if (credit <= 0) {
    return { outcome: 'done', credit: 0, message: '今日已签到' }
  }

  return {
    outcome: 'claimed',
    credit,
    message: `${names.join(' + ') || '今日积分'} +${credit}`,
    ...(names.length > 0 ? { names } : {}),
    ...(hasNewRewardBill ? { hasNewRewardBill: true } : {})
  }
}
