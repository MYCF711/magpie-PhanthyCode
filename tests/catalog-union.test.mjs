// tests/catalog-union.test.mjs —— 两个模型目录合并的语义锁
//
// 全部离线：只喂目录页对象，不发请求。
// 这些断言对应的都是「写错了不报错、只是列表少几条 / 倍率不对」的地方。

import test from "node:test"
import assert from "node:assert/strict"

import { catalogRows, isChatLike, mergeCatalogs } from "../src/catalog-union.mjs"

// 客户端读的那份：cli agent 的 id + 模型行 + 促销表
const clientPage = () => ({
  agents: [
    { name: "cli", models: ["a", "shared"] },
    // craft 引用了一行图片模型：它不该混进聊天列表
    { name: "craft", models: ["img-only"] },
  ],
  models: [
    { id: "a", name: "A", maxInputTokens: 1000, rate: 2 },
    { id: "shared", name: "Shared old", maxInputTokens: 2000, rate: 1.5 },
    { id: "img-only", name: "Image", tags: ["text-to-image"] },
  ],
  modelPromotions: [{ kind: "discount", modelIds: ["a"] }],
})

// 控制台那份：更新，带完整元数据，包一层 data，每项把模型嵌在 model 里
const consolePage = () => ({
  data: [
    { model: { id: "shared", name: "Shared new", maxInputTokens: 3000, rate: 0.1 } },
    { model: { id: "b", name: "B", maxInputTokens: 4000, rate: 0 } },
    { model: { id: "auto", name: "Auto" } },
  ],
})

test("catalogRows 认三种形状，嵌套 model 的字段优先，没有 id 的丢掉", () => {
  assert.deepEqual(catalogRows({ models: [{ id: "a" }, { name: "no id" }] }).map((r) => r.id), ["a"])
  assert.deepEqual(catalogRows({ data: [{ model: { id: "b" } }, { id: "c" }, null] }).map((r) => r.id), ["b", "c"])
  assert.deepEqual(catalogRows([{ id: "d" }]).map((r) => r.id), ["d"])
  assert.deepEqual(catalogRows({ unexpected: true }), [])

  // 外壳上的 id 不作数，内层的赢
  const [nested] = catalogRows({ data: [{ id: "outer", model: { id: "inner", rate: 1 } }] })
  assert.equal(nested.id, "inner")
  assert.equal(nested.rate, 1)
})

test("isChatLike 挡住别名、补全、过小输出、生成图与附属行", () => {
  assert.equal(isChatLike({ id: "glm-5.3", maxOutputTokens: 32_000 }), true)
  assert.equal(isChatLike({ id: "auto" }), false)
  assert.equal(isChatLike({ id: "default" }), false)
  assert.equal(isChatLike({ id: "nes-fim" }), false)
  assert.equal(isChatLike({ id: "completion-x" }), false)
  assert.equal(isChatLike({ id: "codewise-rewrite" }), false)
  assert.equal(isChatLike({ id: "tiny", maxOutputTokens: 256 }), false)
  assert.equal(isChatLike({ id: "img", tags: ["text-to-image"] }), false)
  assert.equal(isChatLike({ id: "extra", supportsExtra: true }), false)
})

test("合并：主目录的行在前，补集补 id，同 id 用主目录的元数据", () => {
  const { ids, rowOf, merged } = mergeCatalogs({ primary: consolePage(), fallback: clientPage() })
  assert.equal(merged, true)
  assert.deepEqual(ids, ["shared", "b", "a"], "主目录的可用行先上，兼容目录独有的补在后面")

  const shared = rowOf.get("shared")
  assert.equal(shared.name, "Shared new", "同 id 时主目录赢")
  assert.equal(shared.maxInputTokens, 3000)
  assert.equal(shared.rate, 0.1, "倍率必须跟着主目录，退回旧值就是用户看到的「价格不对」")

  assert.equal(ids.includes("auto"), false, "路由别名不能进聊天列表")
  assert.equal(ids.includes("img-only"), false, "craft 引用的图片行也要被过滤")
})

test("合并：促销表从任一页取，只认数组", () => {
  const { promotions } = mergeCatalogs({ primary: consolePage(), fallback: clientPage() })
  assert.equal(Array.isArray(promotions), true)
  assert.deepEqual(promotions, [{ kind: "discount", modelIds: ["a"] }])

  const none = mergeCatalogs({ primary: { data: [{ model: { id: "x" } }] }, fallback: null })
  assert.deepEqual(none.promotions, [])
})

test("只有兼容目录时，一个 id 都不多加", () => {
  const { ids, merged } = mergeCatalogs({ fallback: clientPage() })
  assert.equal(merged, false)
  assert.deepEqual(ids, ["a", "shared"], "只列兼容 agent 的列表，craft 与图片行不进来")
})

test("两份都读不到 → 抛，让调用方回退快照；不返回空表", () => {
  assert.throws(() => mergeCatalogs({ primary: null, fallback: null }), /至少给一个目录页/)
})

test("主目录里全是非聊天行 → 抛，而不是给一个空供应商", () => {
  assert.throws(
    () => mergeCatalogs({ primary: { data: [{ model: { id: "auto" } }] }, fallback: null }),
    /没有可用的聊天模型/,
  )
})

test("只有兼容目录时不过滤：兼容面必须和单目录时代一模一样", () => {
  // cli agent 里就算有别名行，也照单全收 —— 这是刻意的，不是漏了 filter。
  const page = { agents: [{ name: "cli", models: ["auto"] }], models: [{ id: "auto" }] }
  assert.deepEqual(mergeCatalogs({ fallback: page }).ids, ["auto"])
})

test("agents 可以定制；第一个是兼容路径用的那一个", () => {
  const page = {
    agents: [
      { name: "cli", models: ["keep"] },
      { name: "craft", models: ["drop"] },
    ],
    models: [],
  }
  assert.deepEqual(mergeCatalogs({ fallback: page, agents: ["cli"] }).ids, ["keep"])
  assert.deepEqual(mergeCatalogs({ fallback: page, agents: ["craft"] }).ids, ["drop"])
  assert.throws(() => mergeCatalogs({ fallback: page, agents: [] }), /至少要给一个 agent 名/)
})
