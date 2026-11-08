// 额度窗口的构造器 —— 把「写错不报错，但 GUI 和路由会坏」的那些坑变成运行时错误。
//
// 为什么需要它：`usage` 钩子返回的窗口是 magpie 画额度条 **和** 智能路由排序的输入。
// 写错字段不会让插件崩，只会让用户看到「剩余额度未知」、让这个号在路由里被当成不存在 ——
// 而插件作者从日志里什么都看不到。
//
// ⚠ 机制已于 2026-10-29 按上游结论更正（issue #468，magpie v0.1.1934）：
//   · **判断一个窗口有没有「占比」只看 `used`**，与 `aside` 无关。没有 `used` 的窗口是
//     text-only：卡片只显示 `display`，**路由不计入**（`allowanceOf` 跳过 ⇒ `routedAllowance`
//     不 ok ⇒ 该号在路由里等于不存在）。
//   · magpie **≥ 0.1.1934**（commit 1390aa458）起，有 `amount` + `limit` 但没有 `used` 的窗口
//     会用 `amount / limit` 推算占比；更旧的版本会把它当 text-only 丢掉。
//   · `aside: true` 的意思是「用光也不停账号」，**路由从不读 aside 窗口**，它只上卡片。
//
// 所以这个构造器的规则是：**`amount` + `limit` 必须同时有 `used`**（没给就自动算），
// 这样跨 magpie 版本行为一致，也不依赖 `aside`。要 text-only 的窗口必须**显式**写
// `textOnly: true`，不能靠「忘了写 used」蒙混过去。
//
// 用法：
//   import { usageWindow, usage } from "./quota.mjs"
//   return usage({
//     plan: "Pro",
//     windows: [
//       usageWindow({ name: "5 hours", used: 37, resetsAt: u.resets_at, span: 18000 }),
//       usageWindow({ name: "积分", amount: 370, limit: 1000, unit: "积分" }), // used 自动 = 37
//       usageWindow({ name: "积分", balance: 6291, unit: "积分" }),
//       usageWindow({ name: "赠送", used: 0, aside: true, display: "5,500" }), // 只上卡片
//       usageWindow({ name: "用量", textOnly: true, display: "1,234 剩余（上限未知）" }),
//     ],
//   })

/** 写法错误（不是上游失败）。调用方应当**重新抛出**，而不是吞成 usage.error ——
 *  因为那是编码错误，静默掉就又会变成「GUI 坏了但日志里什么都没有」。 */
export class QuotaShapeError extends Error {
  constructor(message) {
    super(message)
    this.name = "QuotaShapeError"
  }
}

const TIME_KEYS = ["resetsAt", "runsOutAt", "until"]
const OFFSET_PATTERN = /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/
const ZONELESS_DATE_PATTERN = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/

/**
 * 「这个窗口已经过构造器」的私有标记。
 *
 * 为什么需要：`usageWindow({textOnly: true, …})` 返回的对象**不含** `textOnly` 字段
 * （那个键只在入参里有意义），于是 `usage({windows})` 再跑一遍构造器时会把它当成
 * 「缺 used 的占比窗口」直接抛 —— 实际形态是：任何带套餐名的账号读额度都抛
 * QuotaShapeError（早期就是这样被 index 的 catch 吞成 `usage.error`，没人发现）。
 * 用不可枚举的 Symbol 记住「已构造」，第二次就不再重判。
 */
const BUILT = Symbol.for("magpie.quota.built")

/** 把厂商给的时间（ISO / 秒 / 毫秒时间戳 / Date）统一成 ISO 字符串。解析不了就抛。
 *  显式 offset 只用于无 zone 的日期时间；自带 Z / offset 的 ISO 始终保留自己的时区。 */
export function toIso(value, field = "time", { offset } = {}) {
  if (offset !== undefined && (typeof offset !== "string" || !OFFSET_PATTERN.test(offset))) {
    throw new QuotaShapeError(`${field}: offset 必须是 +08:00 / -05:30 这样的 ±HH:mm，收到 ${offset}`)
  }
  if (value == null) return undefined
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new QuotaShapeError(`${field}: 无效的 Date`)
    return value.toISOString()
  }
  if (typeof value === "number") {
    // 厂商常给秒级时间戳：10 位按秒、13 位按毫秒
    const ms = value < 1e12 ? value * 1000 : value
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) throw new QuotaShapeError(`${field}: ${value} 不是有效时间戳`)
    return d.toISOString()
  }
  const s = String(value).trim()
  if (offset !== undefined) {
    const m = s.match(ZONELESS_DATE_PATTERN)
    if (m) {
      // 不能先 Date.parse：无 zone 的字符串会被宿主本地时区吃掉。先校验真实日历，再拼上指定偏移。
      const year = Number(m[1])
      const month = Number(m[2])
      const day = Number(m[3])
      const hour = Number(m[4])
      const minute = Number(m[5])
      const second = Number(m[6] ?? 0)
      const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
      const valid = month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0) &&
        hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59
      if (!valid) throw new QuotaShapeError(`${field}: "${s}" 不是有效日期`)
      const fraction = m[7] ? `.${m[7]}` : ""
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${fraction}${offset}`)
      if (Number.isNaN(d.getTime())) throw new QuotaShapeError(`${field}: "${s}" 不是有效日期`)
      return d.toISOString()
    }
    const hasDateTimePrefix = /^\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}/.test(s)
    const hasOwnZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)
    // V8 会宽松吞掉某些尾部垃圾；看似无 zone 日期时间但匹配不完整时不能交给它猜。
    if (hasDateTimePrefix && !hasOwnZone) throw new QuotaShapeError(`${field}: "${s}" 不是有效日期`)
  }
  // 先原样试（ISO），再试「2026-10-28 23:59:59」这种厂商原样格式
  const direct = Date.parse(s)
  if (!Number.isNaN(direct)) return new Date(direct).toISOString()
  const m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  // 显式 offset 时不走这个宽松补解析，避免畸形尾部又落回宿主本地时区。
  if (offset === undefined && m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0))
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  throw new QuotaShapeError(
    `${field}: 无法解析 "${s}"。magpie 只认 ISO / 时间戳 —— ` +
    `塞厂商原样格式会让整条窗口被丢掉（AGENTS 坑 22）`,
  )
}

/**
 * 构造一个额度窗口，并在构造时把「静默失败」的写法拦下来。
 * 返回的对象可以直接放进 `usage().windows`。
 *
 * 四种形态，选一种：
 *   ① 占比型   `used`（0-100，可 >100）
 *   ② 数量型   `amount` + `limit`（`used` 没给就按 amount/limit 算）
 *   ③ 钱包型   `balance` + `unit`（只给余额，不给 used/limit）
 *   ④ 文本型   `textOnly: true` + `display`（明确「我不知道占比」，路由不计这个窗口）
 */
export function usageWindow(w = {}) {
  const out = {}
  for (const [k, v] of Object.entries(w)) if (v !== undefined && k !== "textOnly") out[k] = v

  for (const k of TIME_KEYS) if (out[k] !== undefined) out[k] = toIso(out[k], k)

  const isWallet = out.balance !== undefined
  const isTextOnly = w.textOnly === true
  const hasShare = out.used !== undefined

  if (out.name === undefined || String(out.name).trim() === "") {
    throw new QuotaShapeError("窗口必须有 name —— 它显示在进度条上方")
  }
  const who = `窗口 "${out.name}"`

  // ── ④ 文本型：必须显式声明，且必须有 display ────────────────────────
  if (isTextOnly) {
    if (hasShare || isWallet || out.amount !== undefined || out.limit !== undefined) {
      throw new QuotaShapeError(
        `${who}: textOnly: true 不能再给 used / balance / amount / limit —— ` +
        `text-only 的意思是「这个窗口没有占比」，混着写会让读者分不清你到底是知道还是不知道`,
      )
    }
    if (out.display === undefined || String(out.display).trim() === "") {
      throw new QuotaShapeError(
        `${who}: textOnly 窗口必须有 display —— 没有占比又没有文字，卡片上就只剩一个空标签`,
      )
    }
    // 官方 #468 结论：没有 used 的窗口路由不计入。这不是错，但调用方要知道。
    return finish(out)
  }

  // ── aside 窗口：路由从不读它，只上卡片（官方 #468 结论）──────────────
  // 但给 amount/limit 会算出「假占比」：分母就是余额本身，永远显示剩余 100%。
  if (out.aside === true && (out.amount !== undefined || out.limit !== undefined)) {
    throw new QuotaShapeError(
      `${who}: aside: true 的窗口不要给 amount/limit —— ` +
      `aside 表示「用光也不停账号」，本来就没有上限；拿余额当分母算出来永远是「剩余 100%」` +
      `（看着漂亮、含义是错的）。只想展示文字就只给 display；真要占比就别标 aside`,
    )
  }

  // ── ③ 钱包型：只有余额，没有上限 ────────────────────────────────────
  if (isWallet) {
    if (!Number.isFinite(Number(out.balance))) {
      throw new QuotaShapeError(`${who}: balance 必须是有限数字，收到 ${out.balance}`)
    }
    out.balance = Number(out.balance)
    if (hasShare) {
      throw new QuotaShapeError(`${who}: 钱包型（有 balance）不要再给 used —— magpie 会把它当占比读`)
    }
    if (out.amount !== undefined || out.limit !== undefined) {
      throw new QuotaShapeError(`${who}: 钱包型不要再给 amount/limit —— 余额就是「剩多少」，没有上限可算占比`)
    }
    return finish(out)
  }

  // ── ② 数量型：amount + limit 成对，used 缺了就自动算 ────────────────
  const hasAmount = out.amount !== undefined || out.limit !== undefined
  if (hasAmount) {
    if (out.amount === undefined || out.limit === undefined) {
      throw new QuotaShapeError(
        `${who}: amount 与 limit 必须成对（收到 amount=${out.amount}, limit=${out.limit}）—— ` +
        `只给一个的话 magpie 算不出占比`,
      )
    }
    const amount = Number(out.amount)
    const limit = Number(out.limit)
    if (!Number.isFinite(amount) || !Number.isFinite(limit) || limit <= 0) {
      throw new QuotaShapeError(`${who}: amount/limit 必须是有限数字且 limit > 0（收到 amount=${amount}, limit=${limit}）`)
    }
    out.amount = amount
    out.limit = limit
    if (!hasShare) {
      // 上游 #468 结论：≥0.1.1934 会用 amount/limit 推算；更旧的版本会当成 text-only 丢掉。
      // 自己算出来，跨版本一致。
      out.used = Math.round((amount / limit) * 10000) / 100
    }
  }

  // ── ① 占比型（或数量型补完之后）：used 必须落在有限数字上 ──────────
  if (!Number.isFinite(Number(out.used))) {
    throw new QuotaShapeError(
      `${who}: used 必填（收到 ${out.used}）。` +
      `没有 used 的窗口是 text-only，**magpie 的路由不会计入它** —— ` +
      `要表达「只有文字、没有占比」请显式写 textOnly: true；要占比就填 0-100 的有限数字`,
    )
  }
  out.used = Number(out.used)

  return finish(out)
}

function finish(out) {
  if (out.span !== undefined) {
    if (!Number.isInteger(Number(out.span)) || Number(out.span) <= 0) {
      throw new QuotaShapeError(`窗口 "${out.name}": span 是窗口长度（秒），必须是正整数，收到 ${out.span}`)
    }
    out.span = Number(out.span)
  }
  // 不可枚举，避免被 JSON.stringify 带出去；只用于「别把已构造的窗口再判一次」
  Object.defineProperty(out, BUILT, { value: true, enumerable: false })
  return out
}

/** 构造整个 usage 返回值。窗口逐个过一遍 usageWindow（已构造的跳过）。 */
export function usage(u = {}) {
  const out = { ...u }
  if (u.windows !== undefined) {
    if (!Array.isArray(u.windows)) throw new QuotaShapeError("usage.windows 必须是数组")
    out.windows = u.windows.map((w) => (w && w[BUILT] === true ? w : usageWindow(w)))

    // 官方 #468 结论：路由跳过 aside 窗口和没有 used 的窗口。一条都不剩 ⇒ 这个号在路由里
    // 等于不存在（路由页「剩余额度未知」，且永远排在已知账号之后）。
    // 例外：钱包型窗口（只有 balance）没有 used，但宿主会按余额读它 —— 它是可路由的。
    // 判据与 Magicrew 实际写法（src/hooks/usage.mjs:53-59）一致，否则只有钱包窗口的账号会被误杀。
    const routable = out.windows.filter(
      (w) => w.aside !== true && (w.used !== undefined || w.balance !== undefined),
    )
    if (out.windows.length > 0 && routable.length === 0) {
      throw new QuotaShapeError(
        "所有窗口都不参与路由（全是 aside: true 或 textOnly）—— " +
        "这个账号会在路由页显示「剩余额度未知」，而且一律排在已知账号之后。" +
        "至少留一条带 used 的窗口（哪怕百分比没有信息量），否则智能路由里就没有这个号",
      )
    }
  }
  for (const k of TIME_KEYS) if (out[k] !== undefined) out[k] = toIso(out[k], k)
  if (out.error !== undefined && typeof out.error !== "string") {
    throw new QuotaShapeError("usage.error 必须是字符串（显示在额度窗口的位置）")
  }
  return out
}