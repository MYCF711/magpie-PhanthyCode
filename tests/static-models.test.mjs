// tests/static-models.test.mjs —— 静态兜底表不猜上下文窗口（审计 R-02 / CHECKLIST A-8）
//
// 判据：静态模型表的 `limit.context` 只能来自 magpie 自己的模型库
// （`~/.cache/magpie/models.json`），查不到就**不写 limit** —— 不编数字。
// 早期这里与 defaultEntry 都写死过窗口 / 输出上限，与 CHECKLIST A-8「不是写死的数字」直接矛盾。

import test, { after } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ⚠ 先重定向 HOME 再动态 import：model-context 的默认库路径在 import 时算好
const home = mkdtempSync(join(tmpdir(), "pw-static-models-"))
process.env.USERPROFILE = home
process.env.HOME = home
const cacheDir = join(home, ".cache", "magpie")
mkdirSync(cacheDir, { recursive: true })
writeFileSync(
  join(cacheDir, "models.json"),
  JSON.stringify({
    vendors: {
      anthropic: {
        models: [
          { id: "claude-opus-4-8", limit: { context: 200_000 } },
        ],
      },
      phanthy: {
        models: [{ id: "phanthy-pro", limit: { context: 1_000_000 } }],
      },
    },
  }),
)

const { MODELS, staticModels } = await import("../src/context.mjs")
const { contextOf } = await import("../src/model-context.mjs")

after(() => rmSync(home, { recursive: true, force: true }))

test("MODELS 只声明 id / 显示名 / 档位，不含写死的窗口", () => {
  assert.ok(Array.isArray(MODELS) && MODELS.length > 0)
  for (const row of MODELS) {
    assert.equal(row.length, 2, "静态表不再带第三列（写死的 context）")
    assert.equal(typeof row[0], "string")
    assert.equal(typeof row[1], "string")
    assert.ok(!row.some((v) => typeof v === "number"), "静态表里不许出现数字常量")
  }
})

test("静态表：模型库里有的 id 用库里的窗口，没有的不写 limit（不猜）", () => {
  const models = staticModels()

  // 库里有：跟随实测值，不是任何写死的默认
  assert.equal(models["phanthy-pro"].limit.context, 1_000_000)
  assert.equal(models["claude-opus-4-8"].limit.context, 200_000)
  // t6 N-01：limit 只有 context —— 以前还写着写死的 output 上限
  assert.deepEqual(models["phanthy-pro"].limit, { context: 1_000_000 })
  assert.equal("output" in models["phanthy-pro"].limit, false, "limit.output 不许填常量")

  // 库里没有：不写 limit（宿主用自己的默认），而不是填 200_000
  for (const id of ["phanthy-fast", "phanthy-ultra", "claude-sonnet-4-6"]) {
    assert.equal("limit" in models[id], false, `${id} 查不到窗口时不能编一个数字`)
  }
})

test("静态表：库本身读不到（HOME 下没有 models.json）时全员不写 limit", () => {
  // 注入一个「永远查不到」的查询器，模拟未登录机器上还没有模型库
  const models = staticModels({ contextOf: () => undefined })
  for (const [id, model] of Object.entries(models)) {
    assert.equal("limit" in model, false, `${id} 不能有 limit`)
  }
  // 但形状该有的还得有：模态 / 五布尔 / api
  for (const model of Object.values(models)) {
    assert.equal(model.api.npm, "@ai-sdk/anthropic")
    for (const key of ["text", "image", "audio", "video", "pdf"]) {
      assert.equal(typeof model.capabilities.input[key], "boolean")
    }
  }
})

test("静态表：contextOf 返回脏值时不采信", () => {
  const models = staticModels({ contextOf: () => 0 })
  assert.equal("limit" in models["phanthy-fast"], false, "0 不是合法窗口")
  const nan = staticModels({ contextOf: () => Number.NaN })
  assert.equal("limit" in nan["phanthy-fast"], false)
})

test("contextOf 的默认实例确实读 magpie 模型库（同一份数据源）", () => {
  assert.equal(contextOf("phanthy-pro"), 1_000_000)
  assert.equal(contextOf("不存在的模型"), undefined)
})
