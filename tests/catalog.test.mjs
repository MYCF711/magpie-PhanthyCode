// tests/catalog.test.mjs —— 模型目录解析与降级（离线）

import test from "node:test"
import assert from "node:assert/strict"

import {
  CONTEXT_KEYS,
  CONTEXT_MAX,
  CONTEXT_MIN,
  CatalogShapeError,
  catalogEntries,
  contextWindowOf,
  parseCatalog,
} from "../src/catalog.mjs"

const CATALOG = {
  schema_version: 1,
  default_model: "phanthy-pro",
  models: [
    {
      id: "phanthy-pro",
      alias: "phanthy-pro",
      label: "Phanthy Pro",
      description: "主力模型",
      context_window_tokens: 200000,
      tier: "pro",
      recommended: true,
      pricing: { input_credits_per_million_tokens: 12, output_credits_per_million_tokens: 60 },
      // 官方按 `typeof v === "boolean"` 消费这四档（claude-sidecar.exe @108098822/885/940）
      capabilities: { effort: true, max_effort: true, gpt_reasoning_effort: false, glm_reasoning_effort: true },
    },
    { id: "phanthy-fast", label: "Phanthy Fast", context_window_tokens: 128000,
      // 意图免费：厂商明确给 0 积分（缺价 ≠ 免费，见下面的价格三态测试）
      pricing: { input_credits_per_million_tokens: 0, output_credits_per_million_tokens: 0 } },
    { id: "embedding-v3", label: "embedding" },
    { id: "phanthy-image", label: "画图" },
    { label: "没有 id 的条目" },
  ],
}

/**
 * 价格三态夹具（AGENTS 坑 2 / `src/models.mjs` 的 `priceOf`）：
 *
 *   有价格   → 列，按 input 积分算倍率
 *   明确 0   → 列，`free: true`
 *   缺 / null / {} / 非法串 / 负数 → **不列**（价格未知，不猜、也不冒充 0）
 */
const PRICE_CATALOG = {
  schema_version: 1,
  default_model: "",
  models: [
    { id: "price-missing", label: "缺 pricing" },
    { id: "price-null", label: "null 价", pricing: { input_credits_per_million_tokens: null, output_credits_per_million_tokens: null } },
    { id: "price-empty", label: "空对象价", pricing: {} },
    { id: "price-illegal", label: "非法字符串", pricing: { input_credits_per_million_tokens: "abc" } },
    { id: "price-negative", label: "负数", pricing: { input_credits_per_million_tokens: -1 } },
    { id: "price-zero", label: "明确 0", pricing: { input_credits_per_million_tokens: 0, output_credits_per_million_tokens: 0 } },
    { id: "price-positive", label: "正数", pricing: { input_credits_per_million_tokens: 3000, output_credits_per_million_tokens: 9000 } },
    // 数字字符串是服务端常见形态（与 contextWindowOf 同一口径）
    { id: "price-string", label: "数字字符串", pricing: { input_credits_per_million_tokens: "1140" } },
  ],
}

const UNKNOWN_PRICE_IDS = ["price-missing", "price-null", "price-empty", "price-illegal", "price-negative"]

test("解析：schema_version 必须是 1，否则不猜字段", () => {
  assert.throws(() => parseCatalog({ ...CATALOG, schema_version: 2 }), CatalogShapeError)
  assert.throws(() => parseCatalog({ ...CATALOG, schema_version: undefined }), CatalogShapeError)
  assert.throws(() => parseCatalog({ schema_version: 1, models: "nope" }), CatalogShapeError)
  assert.throws(() => parseCatalog(null), CatalogShapeError)
})

test("解析：单条缺 id 直接不列，不拿别的字段凑", () => {
  const parsed = parseCatalog(CATALOG)
  assert.deepEqual(parsed.models.map((m) => m.id), [
    "phanthy-pro",
    "phanthy-fast",
    "embedding-v3",
    "phanthy-image",
  ])
  assert.equal(parsed.defaultModel, "phanthy-pro")
})

test("解析：价格是 credits/百万 token，不进美元语义的 cost", () => {
  const parsed = parseCatalog(CATALOG)
  assert.deepEqual(parsed.models[0].pricing, { inputCreditsPerMillion: 12, outputCreditsPerMillion: 60 })
})

test("解析：四个思考档位按官方消费方式读成布尔（字符串一律不算）", () => {
  const parsed = parseCatalog(CATALOG)
  assert.deepEqual(parsed.models[0].capabilities, {
    effort: true,
    maxEffort: true,
    gptReasoningEffort: false,
    glmReasoningEffort: true,
  })

  // 服务端如果下发字符串（旧实现按字符串读，`trimmed(true)` 得到 ""，三档全丢），
  // 现在一律不算「有这个能力」—— 宁可少一档，也不要把 "" 当档位名发给上游。
  const strings = parseCatalog({
    schema_version: 1,
    models: [{ id: "x", capabilities: { effort: "yes", max_effort: "high", gpt_reasoning_effort: "", glm_reasoning_effort: "" } }],
  })
  assert.deepEqual(strings.models[0].capabilities, {
    effort: false,
    maxEffort: false,
    gptReasoningEffort: false,
    glmReasoningEffort: false,
  })
})

test("上下文窗口：按官方回退链 context_window → context_window_tokens → contextWindow，且只收区间内整数", () => {
  assert.deepEqual(CONTEXT_KEYS, ["context_window", "context_window_tokens", "contextWindow"])
  assert.equal(contextWindowOf({ context_window: 128000, context_window_tokens: 200000 }), 128000)
  assert.equal(contextWindowOf({ context_window_tokens: 200000 }), 200000)
  assert.equal(contextWindowOf({ contextWindow: 64000 }), 64000)
  // 脏数据不猜：太小 / 太大 / 非整数 / 字符串
  assert.equal(contextWindowOf({ context_window: CONTEXT_MIN - 1 }), undefined)
  assert.equal(contextWindowOf({ context_window: CONTEXT_MAX + 1 }), undefined)
  assert.equal(contextWindowOf({ context_window: 1000.5 }), undefined)
  assert.equal(contextWindowOf({ context_window: "200000" }), 200000, "数字字符串是服务端常见形态，按数值收")
  assert.equal(contextWindowOf({}), undefined)
})

test("条目：上下文按服务端给的值；没给就不写 limit（不猜窗口）", () => {
  const { models, withoutContext } = catalogEntries(parseCatalog(CATALOG))

  assert.equal(models["phanthy-pro"].limit.context, 200000)
  // t6 N-01：limit 里只写查到的 context —— `output` 以前写死过上限，那是猜的数字
  // （HOOKS 十一之三：limit 缺失/为 0 时宿主自己去查模型库）。
  assert.deepEqual(models["phanthy-pro"].limit, { context: 200000 })
  assert.equal("output" in models["phanthy-pro"].limit, false, "limit.output 不许填常量")
  assert.equal(models["phanthy-pro"].name, "Phanthy Pro")
  assert.equal(models["phanthy-pro"].api.npm, "@ai-sdk/anthropic")
  // 倍率 = input 积分 / 3000（2026-11-09 对表实证）；夹具价 12 → 0.004 → 两位小数下是 0
  assert.equal(models["phanthy-pro"].rate, 0, "倍率必须按 input 积分 / 3000 算")
  assert.equal("free" in models["phanthy-pro"], false, "价格非 0 就不能标免费（四舍五入到 0 也不行）")
  // 坑 2 / 审计 F9：没有可证实的美元价格就不写 cost，写 0 等于宣称列表价 $0
  assert.equal("cost" in models["phanthy-pro"], false, "不能把「不知道价格」写成 cost: 0")

  assert.equal(models["phanthy-fast"].limit.context, 128000)
  // 夹具里 phanthy-fast 显式给 0 积分：这才是「意图免费」的表达方式（缺价不等于免费）
  assert.equal(models["phanthy-fast"].free, true, "显式 0 积分必须标 free，否则 Free first 永不派发")
  assert.equal(models["phanthy-fast"].rate, 0)
  assert.equal(withoutContext, 0)
})

test("条目：无关模型被 isUsable 过滤（embedding / 生图不进 chat 列表，坑 20）", () => {
  const { models, filteredOut } = catalogEntries(parseCatalog(CATALOG))
  assert.equal("embedding-v3" in models, false)
  assert.equal("phanthy-image" in models, false)
  assert.equal(filteredOut, 2)
})

test("条目：reasoning 只按服务端 capabilities.effort 走", () => {
  const { models } = catalogEntries(parseCatalog(CATALOG))
  assert.equal(models["phanthy-pro"].capabilities.reasoning, true)
  assert.equal(models["phanthy-fast"].capabilities.reasoning, false, "目录没说会思考就不能默认 true")
  // 五个模态键必须显式布尔
  for (const key of ["text", "image", "audio", "video", "pdf"]) {
    assert.equal(typeof models["phanthy-fast"].capabilities.input[key], "boolean")
  }
})

test("空目录 → 空对象（由调用方决定退回静态表，而不是这里编造）", () => {
  const { models } = catalogEntries({ schemaVersion: 1, defaultModel: "", models: [] })
  assert.deepEqual(models, {})
})

// ── 价格三态（缺陷 A：`Number(...) || 0` 把「不知道」说成「免费」）─────────────

test("解析：价格三态 —— 缺失 / null / {} / 非法字符串 / 负数一律不落成 0", () => {
  const parsed = parseCatalog(PRICE_CATALOG)
  const byId = Object.fromEntries(parsed.models.map((m) => [m.id, m]))

  for (const id of UNKNOWN_PRICE_IDS) {
    // 关键断言：连键都不写（写 undefined 也会被 structuredClone/JSON 之外的读者当成「有值」）
    assert.equal("inputCreditsPerMillion" in byId[id].pricing, false, `${id}: 未知价格不能写成 0`)
    assert.equal("outputCreditsPerMillion" in byId[id].pricing, false, `${id}: 未知价格不能写成 0`)
  }

  // 显式 0 必须原样保留（`|| 0` 会把它和「缺价」混成一个值，方向反了）
  assert.equal(byId["price-zero"].pricing.inputCreditsPerMillion, 0)
  assert.equal(byId["price-zero"].pricing.outputCreditsPerMillion, 0)
  assert.equal(byId["price-positive"].pricing.inputCreditsPerMillion, 3000)
  assert.equal(byId["price-string"].pricing.inputCreditsPerMillion, 1140, "数字字符串按数值收")
})

test("条目：缺价的单条不列（目录成功 ≠ 猜价格），显式 0 与正数照列", () => {
  const { models, missingPrice } = catalogEntries(parseCatalog(PRICE_CATALOG))

  for (const id of UNKNOWN_PRICE_IDS) {
    assert.equal(id in models, false, `${id}: 价格未知就不能列（否则卡片上会显示 0x / 免费）`)
  }
  assert.equal(missingPrice, UNKNOWN_PRICE_IDS.length)

  // 明确 0 → free:true + rate 0
  assert.equal(models["price-zero"].free, true)
  assert.equal(models["price-zero"].rate, 0)
  // 正数 → 倍率 3000/3000 = 1，且不能带 free
  assert.equal(models["price-positive"].rate, 1)
  assert.equal("free" in models["price-positive"], false, "非 0 价格绝不能标免费")
  // 数字字符串 1140 → 0.38x，不免费
  assert.equal(models["price-string"].rate, 0.38)
  assert.equal("free" in models["price-string"], false)
})

test("creditsOf：只接受「厂商明确给的合法数值」，其余一律 undefined", async () => {
  const { creditsOf } = await import("../src/catalog.mjs")
  assert.equal(typeof creditsOf, "function", "价格三态必须有一个可断言的真源（creditsOf）")

  assert.equal(creditsOf(0), 0, "显式 0 是合法价格，必须保留")
  assert.equal(creditsOf(1140), 1140)
  assert.equal(creditsOf("1140"), 1140, "数字字符串是服务端常见形态")
  assert.equal(creditsOf(0.5), 0.5)

  for (const unknown of [undefined, null, "", "   ", "abc", {}, [], true, false, Number.NaN, Number.POSITIVE_INFINITY, -1, -0.5]) {
    assert.equal(creditsOf(unknown), undefined, `${JSON.stringify(unknown) ?? String(unknown)} 不是合法价格`)
  }
})
