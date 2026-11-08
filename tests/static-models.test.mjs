// tests/static-models.test.mjs —— 未登录时的兜底表
//
// 两个判据：
//   ① 兜底表的 **id 必须与真实目录同形**（大小写、命名都对），否则用户未登录时
//      看到的是一份假列表 —— 早期写死过 `claude-opus-4-8` / `claude-sonnet-4-6`，
//      这两个模型在 code.phanthy.com 上**根本不存在**。
//   ② 上下文窗口只能来自 magpie 的模型库，查不到就**不写** `limit` —— 不猜。

import test from "node:test"
import assert from "node:assert/strict"

const { MODELS, staticModels } = await import("../src/context.mjs")

test("兜底表的 id 全部非空且唯一（写错 id = 用户选了报 404）", () => {
  const ids = MODELS.map(([id]) => id)
  assert.ok(ids.length > 0, "兜底表不能为空")
  assert.equal(new Set(ids).size, ids.length, "id 不能重复")
  for (const id of ids) {
    assert.equal(typeof id, "string")
    assert.ok(id.trim().length > 0, `空 id：${JSON.stringify(id)}`)
  }
})

test("兜底表必须包含官方默认模型 Phanthy-fast（大小写与目录一致）", () => {
  const ids = MODELS.map(([id]) => id)
  assert.ok(ids.includes("Phanthy-fast"), `缺少 Phanthy-fast，实际：${ids.join(", ")}`)
  // 旧实现写成全小写 `phanthy-fast`，与真实 id 对不上
  assert.equal(ids.includes("phanthy-fast"), false, "不能再用全小写 id")
})

test("兜底表的每一行都有显示名（不能靠 id 兜底）", () => {
  for (const [id, name] of MODELS) {
    assert.equal(typeof name, "string", `${id} 缺显示名`)
    assert.ok(name.trim().length > 0, `${id} 的显示名为空`)
  }
})

test("静态表：模型库里有的 id 用库里的窗口，没有的不写 limit（不猜）", () => {
  // 数据驱动：不写死具体模型名，只看「库认识」与「库不认识」两种情况的形状
  const KNOWN = 1_000_000
  const models = staticModels({ contextOf: (id) => (id === "Phanthy-pro" ? KNOWN : undefined) })

  assert.equal(models["Phanthy-pro"].limit.context, KNOWN, "库里有就跟随实测值")
  assert.deepEqual(models["Phanthy-pro"].limit, { context: KNOWN })
  // t6 N-01：limit 只有 context —— 以前还写着写死的 output 上限
  assert.equal("output" in models["Phanthy-pro"].limit, false, "limit.output 不许填常量")

  // 库里没有：不写 limit（宿主用自己的默认），而不是填一个保守值
  for (const [id] of MODELS) {
    if (id === "Phanthy-pro") continue
    assert.equal("limit" in models[id], false, `${id} 查不到窗口时不能编一个数字`)
  }
})

test("静态表：库本身读不到时全员不写 limit", () => {
  const models = staticModels({ contextOf: () => undefined })
  for (const [id, model] of Object.entries(models)) {
    assert.equal("limit" in model, false, `${id} 不能有 limit`)
  }
})

test("静态表：contextOf 返回脏值时不采信", () => {
  for (const dirty of [0, -1, Number.NaN, 0.5, "abc"]) {
    const models = staticModels({ contextOf: () => dirty })
    for (const [id, model] of Object.entries(models)) {
      assert.equal("limit" in model, false, `${id}：${JSON.stringify(dirty)} 不是合法窗口`)
    }
  }
})
