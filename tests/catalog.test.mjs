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
    { id: "phanthy-fast", label: "Phanthy Fast", context_window_tokens: 128000 },
    { id: "embedding-v3", label: "embedding" },
    { id: "phanthy-image", label: "画图" },
    { label: "没有 id 的条目" },
  ],
}

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
