// tests/catalog-cache.test.mjs —— 目录缓存：TTL / 单飞 / 失败降级 / 按账号隔离（离线）

import test from "node:test"
import assert from "node:assert/strict"

import { catalogFile, createCatalogCache } from "../src/catalog-cache.mjs"

function memoryStore() {
  const files = new Map()
  return {
    files,
    readJson: (file, fallback) => (files.has(file) ? files.get(file) : fallback),
    writeJson: (file, value) => files.set(file, value),
  }
}

test("文件名带账号：同一 provider 下两个账号不共用一个文件", () => {
  const a = catalogFile("acct-a")
  const b = catalogFile("acct-b")
  assert.notEqual(a, b)
  assert.match(a, /catalog-phanthycode__acct-a\.json$/)
  assert.match(b, /catalog-phanthycode__acct-b\.json$/)
})

test("TTL 内只算一次；过期后重算", async () => {
  let clock = 1_000
  let calls = 0
  const store = memoryStore()
  const cache = createCatalogCache({ ttlMs: 10_000, now: () => clock, ...store })

  const compute = async () => {
    calls += 1
    return { m: { id: "m" } }
  }

  assert.equal((await cache.read("acct-a", compute)).m.id, "m")
  assert.equal((await cache.read("acct-a", compute)).m.id, "m")
  assert.equal(calls, 1, "TTL 内第二次必须命中缓存")

  clock += 10_001
  await cache.read("acct-a", compute)
  assert.equal(calls, 2, "过期后必须重算")
})

test("单飞：并发读同一个账号只打一次上游", async () => {
  let calls = 0
  const cache = createCatalogCache({ ...memoryStore() })
  const compute = async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { m: {} }
  }

  const [a, b, c] = await Promise.all([cache.read("acct-a", compute), cache.read("acct-a", compute), cache.read("acct-a", compute)])
  assert.equal(calls, 1)
  assert.deepEqual(a, b)
  assert.deepEqual(b, c)
})

test("按账号隔离：a 的缓存不会被 b 命中", async () => {
  const cache = createCatalogCache({ ...memoryStore() })
  let calls = 0
  const compute = (tag) => async () => {
    calls += 1
    return { tag }
  }
  await cache.read("acct-a", compute("a"))
  const b = await cache.read("acct-b", compute("b"))
  assert.equal(b.tag, "b")
  assert.equal(calls, 2)
})

test("失败：不缓存成功值，30 秒内直接抛；之后允许重试", async () => {
  let clock = 1_000
  let calls = 0
  const cache = createCatalogCache({ failTtlMs: 30_000, now: () => clock, ...memoryStore() })
  const failing = async () => {
    calls += 1
    throw new Error("upstream down")
  }

  await assert.rejects(() => cache.read("acct-a", failing), /upstream down/)
  await assert.rejects(() => cache.read("acct-a", failing), /upstream down/)
  assert.equal(calls, 1, "失败结果在 failTtl 内不应重打上游")

  clock += 30_001
  await assert.rejects(() => cache.read("acct-a", failing))
  assert.equal(calls, 2)
})

test("lastSnapshot：上次成功落盘的值可作降级；没有则 null", async () => {
  const store = memoryStore()
  const cache = createCatalogCache({ ...store })
  assert.equal(cache.lastSnapshot("acct-a"), null)

  await cache.read("acct-a", async () => ({ m: { id: "m" } }))
  assert.deepEqual(cache.lastSnapshot("acct-a"), { m: { id: "m" } })

  // 另一个账号没有快照，不能互相借用
  assert.equal(cache.lastSnapshot("acct-b"), null)
})
