// tests/usage-cache.test.mjs —— 额度读取缓存 + 耗尽闸
//
// 全部离线：compute 是注入的假函数，时间也是注入的。

import test from "node:test"
import assert from "node:assert/strict"

import { createUsageCache, exhausted, publicUsage } from "../src/usage-cache.mjs"

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// 只排空 promise 微任务，不依赖真实时间；deferred 的后续链也能完整落地。
async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

test("成功结果在 ttlMs 内命中缓存，不同 key 不串", async () => {
  let at = 0
  const cache = createUsageCache({ ttlMs: 5_000, failTtlMs: 1_000, now: () => at })
  let a = 0
  let b = 0
  const computeA = async () => {
    a += 1
    return { windows: [{ name: "a" }] }
  }
  const computeB = async () => {
    b += 1
    return { windows: [{ name: "b" }] }
  }

  assert.deepEqual(await cache.read("session-a", computeA), { windows: [{ name: "a" }] })
  assert.deepEqual(await cache.read("session-a", computeA), { windows: [{ name: "a" }] })
  assert.equal(a, 1)
  assert.equal(cache.size, 1)

  assert.deepEqual(await cache.read("session-b", computeB), { windows: [{ name: "b" }] })
  assert.equal(a, 1)
  assert.equal(b, 1)
  assert.equal(cache.size, 2)

  at += 5_001
  await cache.read("session-a", computeA)
  assert.equal(a, 2, "过期后必须重新计算")
})

test("失败结果只缓存 failTtlMs，过期后允许重试", async () => {
  let at = 0
  const cache = createUsageCache({ failTtlMs: 1_000, now: () => at })
  let calls = 0
  const failure = new Error("upstream timeout")
  const compute = async () => {
    calls += 1
    throw failure
  }

  await assert.rejects(cache.read("s", compute), (e) => e === failure)
  await assert.rejects(cache.read("s", compute), (e) => e === failure)
  assert.equal(calls, 1, "failTtlMs 内应命中失败缓存")

  at += 1_001
  await assert.rejects(cache.read("s", compute), (e) => e === failure)
  assert.equal(calls, 2, "失败缓存过期后必须重试")
})

test("同 key 并发只执行一次，等待者拿到同一个结果", async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const cache = createUsageCache()
  const compute = async () => {
    calls += 1
    await gate
    return { windows: [{ used: 1 }] }
  }

  const tasks = Array.from({ length: 8 }, () => cache.read("same", compute))
  await Promise.resolve()
  assert.equal(calls, 1)
  assert.equal(cache.pending, 1)
  release()
  const values = await Promise.all(tasks)
  assert.equal(calls, 1)
  for (const value of values) assert.deepEqual(value, { windows: [{ used: 1 }] })
  assert.equal(cache.pending, 0)
})

test("clear() 清全部；clear(key) 只清指定 key", async () => {
  const cache = createUsageCache()
  let a = 0
  let b = 0
  await cache.read("a", async () => ++a)
  await cache.read("b", async () => ++b)
  cache.clear("a")
  assert.equal(cache.size, 1)
  assert.equal(await cache.read("a", async () => ++a), 2)
  assert.equal(await cache.read("b", async () => ++b), 1)
  cache.clear()
  assert.equal(cache.size, 0)
})

test("ttlMs: 0 表示不缓存", async () => {
  const cache = createUsageCache({ ttlMs: 0, failTtlMs: 0 })
  let calls = 0
  const fn = async () => ++calls
  assert.equal(await cache.read("k", fn), 1)
  assert.equal(await cache.read("k", fn), 2)
})

test("readSWR 立即返回过期成功值，同 key 只有一个后台刷新", async () => {
  let at = 0
  const cache = createUsageCache({ ttlMs: 10, now: () => at })
  const oldValue = { version: "old" }
  const newValue = { version: "new" }
  await cache.readSWR("account", async () => oldValue)

  at = 11
  const gate = deferred()
  let calls = 0
  const compute = () => {
    calls += 1
    return gate.promise
  }
  let delivered
  void cache.readSWR("account", compute).then((value) => {
    delivered = value
  })
  await settle()
  assert.equal(delivered, oldValue, "后台计算未完成时也必须已经交付 stale")
  assert.equal(calls, 1)
  assert.equal(cache.pending, 1)

  assert.equal(await cache.readSWR("account", compute), oldValue)
  assert.equal(await cache.readSWR("account", compute), oldValue)
  await settle()
  assert.equal(calls, 1, "多个 stale 读取必须合并到同一个后台任务")

  gate.resolve(newValue)
  await settle()
  assert.equal(cache.pending, 0)
  assert.equal(await cache.readSWR("account", compute), newValue)
  assert.equal(calls, 1)
})

test("readSWR 后台失败记 failTtlMs，三次 stale 读取只算一次且过期才重试", async () => {
  let at = 0
  const cache = createUsageCache({ ttlMs: 5, failTtlMs: 20, now: () => at })
  const oldValue = { version: "old" }
  await cache.readSWR("s", async () => oldValue)

  at = 6
  let calls = 0
  const compute = async () => {
    calls += 1
    throw new Error("refresh failed")
  }
  assert.equal(await cache.readSWR("s", compute), oldValue)
  await settle()
  assert.equal(cache.pending, 0)
  assert.equal(calls, 1)

  // 后台任务已失败落地；failTtlMs 内继续返回旧成功值，不能重复触发失败计算。
  assert.equal(await cache.readSWR("s", compute), oldValue)
  assert.equal(await cache.readSWR("s", compute), oldValue)
  await settle()
  assert.equal(calls, 1)
  assert.equal(cache.pending, 0)

  // 失败 TTL 过期后才允许刷新；本次仍先给 stale，成功后替换旧值。
  at = 26
  const newValue = { version: "new" }
  let retries = 0
  assert.equal(await cache.readSWR("s", async () => {
    retries += 1
    return newValue
  }), oldValue)
  await settle()
  assert.equal(retries, 1)
  assert.equal(calls, 1)
  assert.equal(cache.pending, 0)
  assert.equal(await cache.readSWR("s", async () => "不应执行"), newValue)
})

test("readSWR 无 stale 时 timeoutMs 有界结束，迟到结果后 pending 清零", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const cache = createUsageCache()
  const gate = deferred()
  let calls = 0
  const waiting = cache.readSWR("slow", () => {
    calls += 1
    return gate.promise
  }, { timeoutMs: 20 })
  const rejected = assert.rejects(waiting, (error) => error.name === "TimeoutError")
  await settle()
  assert.equal(calls, 1)

  t.mock.timers.tick(20)
  await rejected
  assert.equal(cache.pending, 1, "超时只结束等待，共享计算仍在后台")
  gate.resolve("late")
  await settle()
  assert.equal(cache.pending, 0)
  assert.equal(await cache.readSWR("slow", async () => "不应执行"), "late")
})

test("readSWR 无 stale 时 AbortSignal 有界结束，计算落地后 pending 清零", async () => {
  const cache = createUsageCache()
  const gate = deferred()
  const controller = new AbortController()
  const reason = new Error("caller cancelled")
  const waiting = cache.readSWR("abort", () => gate.promise, { signal: controller.signal })
  const rejected = assert.rejects(waiting, (error) => error === reason)
  await settle()
  assert.equal(cache.pending, 1)

  controller.abort(reason)
  await rejected
  assert.equal(cache.pending, 1)
  gate.resolve("late")
  await settle()
  assert.equal(cache.pending, 0)
})

test("readSWR 不同账号的 stale 与后台刷新互不串联", async () => {
  let at = 0
  const cache = createUsageCache({ ttlMs: 5, now: () => at })
  await cache.readSWR("a", async () => "a-old")
  await cache.readSWR("b", async () => "b-old")

  at = 6
  const gateA = deferred()
  const gateB = deferred()
  let callsA = 0
  let callsB = 0
  const computeA = () => {
    callsA += 1
    return gateA.promise
  }
  const computeB = () => {
    callsB += 1
    return gateB.promise
  }
  assert.equal(await cache.readSWR("a", computeA), "a-old")
  assert.equal(await cache.readSWR("b", computeB), "b-old")
  await settle()
  assert.equal(callsA, 1)
  assert.equal(callsB, 1)
  assert.equal(cache.pending, 2)

  gateB.resolve("b-new")
  await settle()
  assert.equal(cache.pending, 1)
  assert.equal(await cache.readSWR("b", computeB), "b-new")
  assert.equal(await cache.readSWR("a", computeA), "a-old")
  gateA.resolve("a-new")
  await settle()
  assert.equal(cache.pending, 0)
  assert.equal(await cache.readSWR("a", computeA), "a-new")
  assert.equal(await cache.readSWR("b", computeB), "b-new")
})

test("readSWR 失败值不能冒充 stale，异常后 pending 清零", async () => {
  let at = 0
  const cache = createUsageCache({ failTtlMs: 5, now: () => at })
  const failure = new Error("bad gateway")
  let calls = 0
  const compute = async () => {
    calls += 1
    throw failure
  }
  await assert.rejects(cache.readSWR("x", compute), (error) => error === failure)
  assert.equal(cache.pending, 0)
  await assert.rejects(cache.readSWR("x", compute), (error) => error === failure)
  assert.equal(calls, 1, "失败仍按 failTtlMs 短缓存，而不是当成成功 stale")

  at = 6
  assert.equal(await cache.readSWR("x", async () => "ok"), "ok")
  assert.equal(cache.pending, 0)
})

test("publicUsage 只去掉顶层下划线字段", () => {
  const value = { windows: [{ _internal: 1, used: 2 }], _quota: { known: true }, plan: "Pro" }
  assert.deepEqual(publicUsage(value), { windows: [{ _internal: 1, used: 2 }], plan: "Pro" })
  assert.equal(publicUsage(null), null)
  assert.deepEqual(publicUsage([1]), [1])
})

test("exhausted 只在有窗口、有余额读数且余额 ≤ lead 时为 true", () => {
  assert.equal(exhausted(null), false)
  assert.equal(exhausted({ error: "x", windows: [{}], balance: 0 }), false)
  assert.equal(exhausted({ windows: [], balance: 0 }), false)
  assert.equal(exhausted({ windows: [{}] }), false, "没有余额字段时放行")
  assert.equal(exhausted({ windows: [{}], balance: "12" }), false)
  assert.equal(exhausted({ windows: [{}], balance: "0" }), true)
  assert.equal(exhausted({ windows: [{}], balance: "0.5" }, { leadPoints: 1 }), true)
  assert.equal(exhausted({ windows: [{}], balance: 2 }, { leadPoints: 1 }), false)
})

test("参数校验：空 key / 非法 TTL / 非法 leadPoints 都抛", () => {
  assert.throws(() => createUsageCache({ ttlMs: -1 }), TypeError)
  assert.throws(() => createUsageCache({ failTtlMs: Infinity }), TypeError)
  const cache = createUsageCache()
  assert.throws(() => cache.read("", async () => 1), TypeError)
  assert.throws(() => cache.read("k", null), TypeError)
  assert.throws(() => exhausted({ windows: [{}], balance: 0 }, { leadPoints: -1 }), TypeError)
})

test("并发失败时所有等待者收到同一个错误，且 pending 清空", async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const failure = new Error("bad gateway")
  const cache = createUsageCache({ failTtlMs: 0 })
  const compute = async () => {
    calls += 1
    await gate
    throw failure
  }
  const p1 = cache.read("x", compute)
  const p2 = cache.read("x", compute)
  release()
  await assert.rejects(p1, (e) => e === failure)
  await assert.rejects(p2, (e) => e === failure)
  assert.equal(calls, 1)
  assert.equal(cache.pending, 0)
})