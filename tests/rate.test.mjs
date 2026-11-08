// tests/rate.test.mjs —— 倍率（卡片上那个 `0.38x`）的换算与 free 三分支
//
// 为什么要单独锁：倍率既是**显示**（模型列表里那一行），也是**Free first 路由**的输入。
// 写错不会报错，只会让卡片上的数字和官方客户端对不上，或者让免费模型被反复派发。
//
// 真值来源：2026-11-09 官方桌面端的模型列表 vs `/api/phanthy_code/models` 的 pricing，
// 逐条对表（12 条全中）。

import test from "node:test"
import assert from "node:assert/strict"

const { rateOf, catalogEntries } = await import("../src/catalog.mjs")
const { MULT_BASE } = await import("../src/models.mjs")

/** 官方客户端截图里的 12 条（id → 显示的倍率） */
const OFFICIAL = {
  "deepseek-v4.1-flash-1017": 0.1,
  "glm-5.2": 0.38,
  "glm-5.3": 0.38,
  "glm-5.3-flash": 0.04,
  "kimi-k2.7-code": 0.31,
  "kimi-k3": 1.0,
  "Phana-5.5o": 0.67,
  "Phana-5.5s": 0.33,
  "Phano-6.1s": 0.33,
  "Phano-6a": 1.67,
  "Phanthy-fast": 0.0,
  "Phanthy-pro": 0.33,
}

/** 目录里的 input 积分（真实值） */
const INPUT_CREDITS = {
  "deepseek-v4.1-flash-1017": 300,
  "glm-5.2": 1140,
  "glm-5.3": 1140,
  "glm-5.3-flash": 120,
  "kimi-k2.7-code": 920,
  "kimi-k3": 3000,
  "Phana-5.5o": 2000,
  "Phana-5.5s": 1000,
  "Phano-6.1s": 1000,
  "Phano-6a": 5000,
  "Phanthy-fast": 0,
  "Phanthy-pro": 1000,
}

test("MULT_BASE 是 3000（2000 会全部算错）", () => {
  assert.equal(MULT_BASE, 3000)
})

test("倍率逐条命中官方客户端的显示值（12 条）", () => {
  for (const [id, expected] of Object.entries(OFFICIAL)) {
    const got = rateOf({ pricing: { inputCreditsPerMillion: INPUT_CREDITS[id] } })
    assert.equal(got, expected, `${id}: 期望 ${expected}x，实际 ${got}x`)
  }
})

test("倍率保留两位小数：0.30666… → 0.31", () => {
  assert.equal(rateOf({ pricing: { inputCreditsPerMillion: 920 } }), 0.31)
  assert.equal(rateOf({ pricing: { inputCreditsPerMillion: 5000 } }), 1.67)
})

test("没有价格 → undefined（不写 rate，不谎标免费）", () => {
  assert.equal(rateOf({}), undefined)
  assert.equal(rateOf({ pricing: {} }), undefined)
  assert.equal(rateOf(undefined), undefined)
  assert.equal(rateOf({ pricing: { inputCreditsPerMillion: Number.NaN } }), undefined)
  assert.equal(rateOf({ pricing: { inputCreditsPerMillion: -1 } }), undefined)
})

test("0 积分 → rate 0 且 **显式** free: true（坑 2：rate 0 本身不等于免费）", () => {
  const catalog = {
    schemaVersion: 1,
    defaultModel: "",
    models: [
      { id: "free-one", name: "Free One", context: 100_000, capabilities: {}, pricing: { inputCreditsPerMillion: 0 } },
    ],
  }
  const { models } = catalogEntries(catalog)
  assert.equal(models["free-one"].rate, 0)
  assert.equal(models["free-one"].free, true, "0 积分必须显式标 free，否则 Free first 永不派发")
})

test("非 0 积分不写 free 字段（rate 与 free 互斥）", () => {
  const catalog = {
    schemaVersion: 1,
    defaultModel: "",
    models: [
      { id: "paid-one", name: "Paid One", context: 100_000, capabilities: {}, pricing: { inputCreditsPerMillion: 1140 } },
    ],
  }
  const { models } = catalogEntries(catalog)
  assert.equal(models["paid-one"].rate, 0.38)
  assert.equal("free" in models["paid-one"], false, "付费模型不能带 free 字段")
})
