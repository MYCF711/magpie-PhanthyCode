// tests/models-adapters.test.mjs —— live models 通用适配层的语义锁

import test from "node:test"
import assert from "node:assert/strict"

import { assignSlugs, makeModelIndex, upstreamModelId, mergeModelMetadata } from "../src/models.mjs"

test("slug: 同名模型按出现顺序编号，重复调用结果稳定", () => {
  const records = [
    { name: "同名", code: "upstream-a" },
    { name: "同名", code: "upstream-b" },
    { name: "同名", code: "upstream-c" },
  ]
  const options = { idOf: (record) => record.name }
  const first = assignSlugs(records, options)
  const second = assignSlugs(records, options)
  assert.deepEqual(first.map((record) => record.id), ["同名", "同名-2", "同名-3"])
  assert.deepEqual(first.map((record) => record.code), ["upstream-a", "upstream-b", "upstream-c"])
  assert.deepEqual(second, first)
})

test("slug: 默认使用上游 code，缺 code 时使用 id", () => {
  const out = assignSlugs([{ code: "from-code" }, { id: "from-id" }])
  assert.deepEqual(out, [
    { id: "from-code", code: "from-code" },
    { id: "from-id", code: "from-id" },
  ])
})

test("index: slug 与 code 可以双向查找", () => {
  const records = assignSlugs([
    { name: "重复", code: "a" },
    { name: "重复", code: "b" },
  ], { idOf: (record) => record.name })
  const index = makeModelIndex(records)
  assert.ok(index.bySlug instanceof Map)
  assert.ok(index.byCode instanceof Map)
  assert.equal(index.bySlug.get("重复-2"), "b")
  assert.equal(index.byCode.get("b"), "重复-2")
})

test("upstreamModelId: 已知 slug 返回 code，未知 id 原样返回", () => {
  const records = assignSlugs([{ code: "upstream-a" }, { code: "upstream-a" }])
  assert.equal(upstreamModelId("upstream-a-2", records), "upstream-a")
  assert.equal(upstreamModelId("not-listed", records), "not-listed")
})

test("merge: 相同 id 继承 limit、capabilities 和 api", () => {
  const fallback = [{
    id: "known",
    limit: { context: 200_000, output: 8_000 },
    capabilities: { input: { text: true, image: false }, toolcall: true },
    api: { id: "known", url: "https://api.example.com/v1", npm: "@ai-sdk/openai-compatible" },
  }]
  const [merged] = mergeModelMetadata([{ id: "known", name: "live name" }], fallback)
  assert.equal(merged.name, "live name")
  assert.deepEqual(merged.limit, fallback[0].limit)
  assert.deepEqual(merged.capabilities, fallback[0].capabilities)
  assert.deepEqual(merged.api, fallback[0].api)
})

test("merge: 未知 live 不继承 fallback 第一条，也不猜 context", () => {
  const fallback = [{
    id: "fallback-only",
    limit: { context: 1_000_000, output: 4_000 },
    capabilities: { toolcall: true },
    api: { id: "fallback-only" },
  }]
  const [merged] = mergeModelMetadata([{ id: "new-live", name: "新模型" }], fallback)
  assert.deepEqual(merged, { id: "new-live", name: "新模型" })
  assert.equal(merged.limit, undefined)
  assert.equal(merged.capabilities, undefined)
  assert.equal(merged.api, undefined)
})

test("merge: 不补回 live 缺失的模型，只深合并 input/output 模态键", () => {
  const live = [{
    id: "known",
    limit: { output: 4_000 },
    capabilities: { input: { text: true } },
  }]
  const fallback = [
    {
      id: "known",
      limit: { context: 900_000, output: 8_000 },
      capabilities: {
        input: { text: true, image: true },
        output: { text: true, image: false },
        toolcall: true,
      },
    },
    { id: "fallback-only", limit: { context: 1_000_000 } },
  ]
  const merged = mergeModelMetadata(live, fallback)
  assert.deepEqual(merged.map((record) => record.id), ["known"])
  assert.deepEqual(merged[0].limit, { output: 4_000 })
  assert.equal(merged[0].limit.context, undefined)
  assert.deepEqual(merged[0].capabilities, {
    input: { text: true, image: true },
    output: { text: true, image: false },
  })
  assert.equal(merged[0].capabilities.toolcall, undefined)
})

test("merge: partial input.image:false 不丢，live false 不被 fallback true 覆盖", () => {
  const [merged] = mergeModelMetadata([{
    id: "known",
    capabilities: {
      input: { image: false },
      output: { text: false },
      toolcall: false,
    },
  }], [{
    id: "known",
    capabilities: {
      input: { text: true, image: true, audio: true },
      output: { text: true, image: true },
      toolcall: true,
      reasoning: true,
    },
  }])

  assert.deepEqual(merged.capabilities, {
    input: { text: true, image: false, audio: true },
    output: { text: false, image: true },
    toolcall: false,
  })
  assert.equal(merged.capabilities.input.image, false)
  assert.equal(merged.capabilities.output.text, false)
  assert.equal(merged.capabilities.reasoning, undefined)
})

test("适配层不修改输入，并返回新的数组和条目", () => {
  const records = [{ name: "同名", code: "a", nested: { keep: true } }]
  const recordsBefore = structuredClone(records)
  const assigned = assignSlugs(records, { idOf: (record) => record.name })
  assert.deepEqual(records, recordsBefore)
  assert.notEqual(assigned, records)
  assert.notEqual(assigned[0], records[0])

  const live = [{ id: "known", name: "live" }]
  const fallback = [{ id: "known", limit: { context: 100_000 } }]
  const liveBefore = structuredClone(live)
  const fallbackBefore = structuredClone(fallback)
  const merged = mergeModelMetadata(live, fallback)
  assert.deepEqual(live, liveBefore)
  assert.deepEqual(fallback, fallbackBefore)
  assert.notEqual(merged, live)
  assert.notEqual(merged[0], live[0])
})
