// tests/semantics.test.mjs —— 锁住「形状对、语义错」的那几处
//
// 为什么需要它：`scripts/check.mjs` 查的是**形状**（导出了什么、字段齐不齐、许可对不对）。
// 但真实踩过的坑几乎都在语义上，而且**都不报错**：
//   · free 从 rate 反推 → 一整批套餐模型被标成免费，Free first 一直派到它们身上
//   · 计费接口整个挂了却按「单条无价格」过滤 → 列表变空
//   · 模型级 400 直接透传成 401 → 整个账号被停用
//   · 流式没带 stream_options.include_usage → 额度永远不扣
//
// 跑法：node --test    （或 node tests/semantics.test.mjs）

import test from "node:test"
import assert from "node:assert/strict"

import { buildModels, priceOf, isUsable, defaultEntry } from "../src/models.mjs"
import { ApiError, asModelError, read } from "../src/api.mjs"
import { withUsage, singleShotToSSE, normalizeUsage } from "../src/chat.mjs"
import { QuotaShapeError, toIso, usage, usageWindow } from "../src/quota.mjs"

// 在测试里显式写出来：倍率系数是实测值，改了必须连测试一起改
const MULT_BASE = 3000  // 实测：input 积分 / 3000 = 官方显示的倍率

const C = { BASE: "https://api.example.com/v1" }
const entry = (id, name, vision, opts) => ({ id, name, vision, ...opts })

// ── free 三分支：全模板最容易错的一处 ────────────────────────────────

test("price: input_points > 0 → 有 rate，不设 free", () => {
  const p = priceOf({ inputPoints: 100 })
  assert.equal(p.known, true)
  assert.equal(p.free, false)
  assert.equal(p.rate, 100 / MULT_BASE)
})

test("price: input_points === 0 → free，且不给 rate", () => {
  const p = priceOf({ inputPoints: 0 })
  assert.deepEqual(p, { known: true, free: true, rate: 0 })
})

test("price: input_points 缺失 → 未知（不猜、不谎标免费）", () => {
  assert.equal(priceOf({}).known, false)
  assert.equal(priceOf(undefined).known, false)
  // 空串是「没填」而不是「等于 0」—— Number("") === 0 会把它误判成免费
  assert.equal(priceOf({ inputPoints: "" }).known, false)
  assert.equal(priceOf({ inputPoints: "abc" }).known, false)
})

test("models: 有价格的模型不会被标成 free（rate 与 free 互斥）", () => {
  const live = [{ id: "a", name: "A" }]
  const { models } = buildModels(live, new Map([["a", { inputPoints: 200 }]]), defaultEntry)
  assert.notEqual(models.a.free, true)
  assert.equal(models.a.rate, 200 / MULT_BASE)
  assert.equal("free" in models.a, false) // defaultEntry 只在确认为真时才写这个字段
})

// ── 三态降级 ────────────────────────────────────────────────────────

test("models: 计费接口整个失败 → 不过滤，列表不空", () => {
  const live = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ]
  const { models, pointsOk } = buildModels(live, {}, entry) // 空计费表 = 接口失败
  assert.equal(pointsOk, false)
  assert.deepEqual(Object.keys(models).sort(), ["a", "b"])
  assert.equal(models.a.rate, 0) // 没有倍率，但有条目
})

test("models: 计费成功但某条没价格 → 不列（用户选了不知道花多少）", () => {
  const live = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ]
  const { models, droppedUnknownPrice } = buildModels(live, new Map([["a", { inputPoints: 50 }]]), entry)
  assert.deepEqual(Object.keys(models), ["a"])
  assert.equal(droppedUnknownPrice, 1)
})

test("models: VIP / 生图 / embedding 不列（选中必报错）", () => {
  assert.equal(isUsable({ id: "gpt-x" }), true)
  assert.equal(isUsable({ id: "gpt-x", tags: [{ value: "vip" }] }), false)
  assert.equal(isUsable({ id: "text-embedding-3" }), false)
  assert.equal(isUsable({ id: "flux-pro" }), false)
  assert.equal(isUsable({}), false)
})

// ── 错误语义：404 不是 401 ──────────────────────────────────────────

test("api: 模型级错误被翻成 404（透传 4xx 会打死整个账号）", () => {
  const e = new ApiError("model not found", { status: 400 })
  assert.equal(asModelError(e).status, 404)
})

test("api: 401 不被改写 —— 那确实是登录失效", () => {
  const e = new ApiError("unauthorized", { status: 401 })
  assert.equal(asModelError(e).status, 401)
})

test("api: 非 ApiError 原样返回", () => {
  const e = new TypeError("boom")
  assert.equal(asModelError(e), e)
})

test("api: read 把非 2xx 变成异常（而不是返回一个空对象）", async () => {
  const res = new Response(JSON.stringify({ message: "bad" }), { status: 500 })
  await assert.rejects(() => read(res, "https://x/y"), (err) => err instanceof ApiError && err.status === 500)
})

test("api: read 把非 JSON 也变成异常（带原文片段，否则查不出是什么）", async () => {
  const res = new Response("<html>502 Bad Gateway</html>", { status: 200 })
  await assert.rejects(() => read(res), /不是 JSON/)
})

// ── 流式三坑 ────────────────────────────────────────────────────────

test("chat: withUsage 给流式请求补 include_usage", () => {
  const b = withUsage({ stream: true, model: "m" })
  assert.deepEqual(b.stream_options, { include_usage: true })
})

test("chat: withUsage 不碰非流式请求", () => {
  const b = withUsage({ stream: false, model: "m" })
  assert.equal(b.stream_options, undefined)
})

test("chat: singleShotToSSE 产出可解析的帧，并以 [DONE] 收尾", async () => {
  const res = singleShotToSSE({ model: "m", text: "你好", usage: { prompt: 3, completion: 4, total: 7 } })
  assert.match(res.headers.get("content-type"), /text\/event-stream/)
  const text = await res.text()
  const frames = text
    .split("\n\n")
    .map((s) => s.trim())
    .filter(Boolean)
  assert.ok(frames.length >= 4, `帧太少：${frames.length}`)
  assert.equal(frames.at(-1), "data: [DONE]")
  const last = JSON.parse(frames.at(-2).replace(/^data: /, ""))
  assert.deepEqual(last.usage, { prompt: 3, completion: 4, total: 7 })
})

test("chat: normalizeUsage 兼容两套字段名，坏数据返回 null", () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 1, completion_tokens: 2 }), { prompt: 1, completion: 2, total: 3 })
  assert.deepEqual(normalizeUsage({ input_tokens: 5, output_tokens: 6 }), { prompt: 5, completion: 6, total: 11 })
  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage({ prompt_tokens: "x" }), null)
})

// ── 额度窗口：写错不报错、但卡片和智能路由会坏的写法 ──────────────────
// 机制已于 2026-10-29 按上游结论更正（issue #468，magpie v0.1.1934）：
//   · 判断「有没有占比」只看 used，与 aside 无关；没有 used 的窗口是 text-only，路由不计入
//   · 有 amount + limit 但没 used：≥0.1.1934 会用 amount/limit 推算，更旧的版本会丢掉
//   · aside 窗口只上卡片，路由从不读它

test("quota: 数量型没给 used → 自动按 amount/limit 算出（跨版本一致，不靠 magpie 推算）", () => {
  const w = usageWindow({ name: "积分", amount: 370, limit: 1000, unit: "积分" })
  assert.equal(w.used, 37)
  assert.equal(w.amount, 370)
  assert.equal(w.limit, 1000)
})

test("quota: amount 与 limit 必须成对，limit > 0", () => {
  assert.throws(() => usageWindow({ name: "积分", amount: 370 }), /必须成对/)
  assert.throws(() => usageWindow({ name: "积分", limit: 1000 }), /必须成对/)
  assert.throws(() => usageWindow({ name: "积分", amount: 5, limit: 0 }), /limit > 0/)
})

test("quota: 既没有 used 也没有 amount/limit、又没声明 textOnly → 抛（那是 text-only 窗口，路由不计入）", () => {
  assert.throws(() => usageWindow({ name: "5 小时", resetsAt: "2026-10-28T00:00:00Z" }), /used 必填/)
  assert.throws(() => usageWindow({ name: "5 小时", used: "37%" }), /used 必填/)
})

test("quota: text-only 窗口必须显式声明，且必须有 display", () => {
  const w = usageWindow({ name: "积分", textOnly: true, display: "1,234 剩余（上限未知）" })
  assert.equal(w.used, undefined)
  assert.equal(w.textOnly, undefined) // 不是 magpie 的字段，不能漏进去
  assert.throws(() => usageWindow({ name: "积分", textOnly: true }), /必须有 display/)
  assert.throws(() => usageWindow({ name: "积分", textOnly: true, display: "x", used: 5 }), /不能再给/)
})

test("quota: aside 窗口不许给 amount/limit（分母是余额本身 ⇒ 永远剩余 100%）", () => {
  assert.throws(() => usageWindow({ name: "赠送", amount: 50, limit: 100, aside: true }), /假占比|剩余 100%/);
  const w = usageWindow({ name: "赠送", used: 0, aside: true, display: "5,500" })
  assert.equal(w.aside, true)
})

test("quota: 所有窗口都不参与路由 → 抛（这个号在路由里等于不存在）", () => {
  assert.throws(
    () => usage({ windows: [{ name: "赠送", used: 0, aside: true, display: "5,500" }] }),
    /所有窗口都不参与路由/,
  )
  assert.throws(
    () => usage({ windows: [{ name: "用量", textOnly: true, display: "1,234" }] }),
    /所有窗口都不参与路由/,
  )
  // 只要有一条参与路由就放行
  const u = usage({ windows: [{ name: "赠送", used: 0, aside: true, display: "5,500" }, { name: "5 小时", used: 37 }] })
  assert.equal(u.windows.length, 2)
})

test("quota: 厂商原样时间 / 秒级时间戳 → 统一成 ISO", () => {
  assert.equal(usageWindow({ name: "a", used: 1, resetsAt: "2026-10-28 23:59:59" }).resetsAt, new Date(2026, 9, 28, 23, 59, 59).toISOString())
  assert.equal(usageWindow({ name: "a", used: 1, resetsAt: 1793000000 }).resetsAt, new Date(1793000000 * 1000).toISOString())
  assert.throws(() => usageWindow({ name: "a", used: 1, resetsAt: "昨天" }), /无法解析/)
})

test("quota: 显式 offset 让无 zone 日期得到确定 instant，负偏移也生效", () => {
  const input = "2026-10-28 23:59:59"
  assert.equal(toIso(input, "time", { offset: "+08:00" }), "2026-10-28T15:59:59.000Z")
  assert.equal(toIso(input, "time", { offset: "-05:30" }), "2026-10-29T05:29:59.000Z")
  assert.equal(toIso("2026/10/28T23:59", "time", { offset: "+08:00" }), "2026-10-28T15:59:00.000Z")
  // 不传 offset 时仍按原来的宿主本地时间解析
  assert.equal(toIso(input), new Date(2026, 9, 28, 23, 59, 59).toISOString())
})

test("quota: 自带 Z / offset 的 ISO 不被显式 offset 覆盖", () => {
  assert.equal(toIso("2026-10-28T23:59:59Z", "time", { offset: "+08:00" }), "2026-10-28T23:59:59.000Z")
  assert.equal(toIso("2026-10-28T23:59:59+09:30", "time", { offset: "-05:30" }), "2026-10-28T14:29:59.000Z")
  assert.equal(toIso("2026-10-28T23:59:59+0930", "time", { offset: "+08:00" }), "2026-10-28T14:29:59.000Z")
})

test("quota: 秒 / 毫秒时间戳不受 offset 影响", () => {
  const ms = 1793000000000
  assert.equal(toIso(ms / 1000, "time", { offset: "+08:00" }), new Date(ms).toISOString())
  assert.equal(toIso(ms, "time", { offset: "-05:30" }), new Date(ms).toISOString())
})

test("quota: 非法 offset / 日期 / 空串抛 QuotaShapeError，null 仍表示未提供", () => {
  for (const offset of ["+8:00", "08:00", "+24:00", "+08:60", "UTC", "", null]) {
    assert.throws(() => toIso("2026-10-28 23:59:59", "time", { offset }), QuotaShapeError)
  }
  for (const input of ["2026-02-30 12:00:00", "2026-13-01 12:00:00", "2026-10-28 24:00:00", "2026-10-28 23:60:00", "2026-10-28 23:59:60", "2026-10-28 23:59:59 junk"]) {
    assert.throws(() => toIso(input, "time", { offset: "+08:00" }), QuotaShapeError)
  }
  assert.throws(() => toIso("", "time", { offset: "+08:00" }), QuotaShapeError)
  assert.throws(() => toIso("   ", "time", { offset: "+08:00" }), QuotaShapeError)
  assert.equal(toIso(null, "time", { offset: "+08:00" }), undefined)
  assert.equal(toIso(undefined, "time", { offset: "+08:00" }), undefined)
})

test("quota: 钱包型（balance）不能再给 used / amount / limit", () => {
  assert.throws(() => usageWindow({ name: "积分", balance: 6291, used: 0, unit: "积分" }), /钱包型/)
  assert.throws(() => usageWindow({ name: "积分", balance: 6291, amount: 1, limit: 2 }), /钱包型/)
  const w = usageWindow({ name: "积分", balance: 6291, unit: "积分" })
  assert.equal(w.balance, 6291)
  assert.equal(w.used, undefined)
})

test("quota: span 不是正整数 → 抛；正常窗口原样通过", () => {
  assert.throws(() => usageWindow({ name: "a", used: 1, span: 0 }), /span/)
  assert.throws(() => usageWindow({ name: "a", used: 1, span: 1.5 }), /span/)
  const w = usageWindow({ name: "5 小时", used: 37, span: 18000, resetsAt: 1793000000 })
  assert.deepEqual(w, { name: "5 小时", used: 37, span: 18000, resetsAt: new Date(1793000000 * 1000).toISOString() })
})

test("quota: 只有 balance 钱包窗口不抛（钱包窗口是路由可见的，不能被误杀）", () => {
  const u = usage({
    windows: [{ name: "积分余额", balance: 6291, unit: "积分", display: "6,291" }],
  })
  assert.equal(u.windows.length, 1)
  assert.equal(u.windows[0].balance, 6291)
  assert.equal(u.windows[0].used, undefined)
})

test("quota: textOnly 仍受约束 —— 全是 text-only 窗口照样抛（不能借 textOnly 绕过路由要求）", () => {
  assert.throws(
    () => usage({ windows: [{ name: "用量", textOnly: true, display: "1,234 剩余（上限未知）" }] }),
    /所有窗口都不参与路由/,
  )
})

test("quota: usage() 逐个过一遍窗口，并且不改动其余字段", () => {
  const u = usage({
    plan: "Pro",
    windows: [{ name: "5 小时", used: 37, span: 18000 }, { name: "积分", balance: 100, unit: "积分" }],
  })
  assert.equal(u.plan, "Pro")
  assert.equal(u.windows.length, 2)
  assert.equal(u.windows[0].used, 37)
  assert.equal(u.windows[1].balance, 100)
})
