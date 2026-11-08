import test from "node:test"
import assert from "node:assert/strict"
import { createStreamReader } from "../src/stream-reader.mjs"

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test("预读超时后到达的首块会排队，不会丢失", async () => {
  const pending = deferred()
  let readCalls = 0
  const reader = createStreamReader({
    read() {
      readCalls += 1
      return pending.promise
    },
  })

  await assert.rejects(reader.read({ timeoutMs: 5 }), { name: "TimeoutError" })
  pending.resolve({ done: false, value: "首块" })
  await Promise.resolve()

  assert.deepEqual(await reader.read(), { done: false, value: "首块" })
  assert.equal(readCalls, 1)
})

test("连续超时复用同一个在飞 read，并分别通知 onTimeout", async () => {
  const pending = deferred()
  const timeouts = []
  let readCalls = 0
  const reader = createStreamReader(
    {
      read() {
        readCalls += 1
        return pending.promise
      },
    },
    { onTimeout: (error) => timeouts.push(error) },
  )

  await assert.rejects(reader.read({ timeoutMs: 5 }), { name: "TimeoutError" })
  await assert.rejects(reader.read({ timeoutMs: 5 }), { name: "TimeoutError" })
  assert.equal(readCalls, 1)
  assert.equal(timeouts.length, 2)
  assert.ok(timeouts.every((error) => error.code === "ERR_STREAM_READ_TIMEOUT"))

  pending.resolve({ done: false, value: "迟到块" })
  assert.deepEqual(await reader.read(), { done: false, value: "迟到块" })
  assert.equal(readCalls, 1)
})

test("abort 只取消当次等待，之后仍能收到在飞 read 的块", async () => {
  const pending = deferred()
  const controller = new AbortController()
  const reason = new Error("主动中止")
  let readCalls = 0
  const reader = createStreamReader({
    read() {
      readCalls += 1
      return pending.promise
    },
  })

  const waiting = reader.read({ signal: controller.signal })
  controller.abort(reason)
  await assert.rejects(waiting, (error) => error === reason)

  pending.resolve({ done: false, value: "中止后到达" })
  await Promise.resolve()
  assert.deepEqual(await reader.read(), { done: false, value: "中止后到达" })
  assert.equal(readCalls, 1)
})

test("已中止的 signal 不会发起底层 read", async () => {
  const controller = new AbortController()
  controller.abort()
  let readCalls = 0
  const reader = createStreamReader({
    read() {
      readCalls += 1
      return Promise.resolve({ done: false, value: "不应读取" })
    },
  })

  await assert.rejects(reader.read({ signal: controller.signal }), { name: "AbortError" })
  assert.equal(readCalls, 0)
})

test("done 消费后持续重放，不再调用底层 read", async () => {
  const pending = deferred()
  let readCalls = 0
  const reader = createStreamReader({
    read() {
      readCalls += 1
      return pending.promise
    },
  })

  const waiting = reader.read()
  pending.resolve({ done: true, value: undefined })
  assert.deepEqual(await waiting, { done: true, value: undefined })
  assert.deepEqual(await reader.read(), { done: true, value: undefined })
  assert.deepEqual(await reader.read(), { done: true, value: undefined })
  assert.equal(readCalls, 1)
})

test("error 消费后持续重放，reader reject 后不再 read", async () => {
  const pending = deferred()
  const failure = new Error("读取失败")
  let readCalls = 0
  const reader = createStreamReader({
    read() {
      readCalls += 1
      return pending.promise
    },
  })

  const waiting = reader.read()
  pending.reject(failure)
  await assert.rejects(waiting, (error) => error === failure)
  await assert.rejects(reader.read(), (error) => error === failure)
  await assert.rejects(reader.read(), (error) => error === failure)
  assert.equal(readCalls, 1)
})

for (const count of [2, 3]) {
  test(`${count} 个并发 read 在 done 时全部结束，后续 read 仍重放`, async () => {
    const pending = deferred()
    let readCalls = 0
    const reader = createStreamReader({
      read() {
        readCalls += 1
        return pending.promise
      },
    })

    const waiting = Array.from({ length: count }, () => reader.read())
    pending.resolve({ done: true, value: undefined })
    assert.deepEqual(
      await Promise.all(waiting),
      Array.from({ length: count }, () => ({ done: true, value: undefined })),
    )
    assert.deepEqual(await reader.read(), { done: true, value: undefined })
    assert.equal(readCalls, 1)
  })

  test(`${count} 个并发 read 在 error 时全部拒绝，后续 read 仍重放`, async () => {
    const pending = deferred()
    const failure = new Error(`读取失败（${count} 个等待者）`)
    let readCalls = 0
    const reader = createStreamReader({
      read() {
        readCalls += 1
        return pending.promise
      },
    })

    const waiting = Array.from({ length: count }, () => reader.read())
    pending.reject(failure)
    const results = await Promise.allSettled(waiting)
    assert.ok(results.every((result) => result.status === "rejected" && result.reason === failure))
    await assert.rejects(reader.read(), (error) => error === failure)
    assert.equal(readCalls, 1)
  })
}

test("终态广播前先按序交付已排队 chunk", async () => {
  const pending = [deferred(), deferred()]
  let readCalls = 0
  const reader = createStreamReader({
    read() {
      return pending[readCalls++].promise
    },
  })

  const first = reader.read()
  pending[0].resolve({ done: false, value: "首块" })
  const second = reader.read()
  const third = reader.read()
  assert.deepEqual(await first, { done: false, value: "首块" })
  assert.equal(readCalls, 2)

  pending[1].resolve({ done: true, value: undefined })
  assert.deepEqual(await second, { done: true, value: undefined })
  assert.deepEqual(await third, { done: true, value: undefined })
  assert.equal(readCalls, 2)
})

test("cancel 转发 reason、拒绝等待者并忽略迟到块", async () => {
  const pending = deferred()
  const reason = new Error("关闭来源")
  const cancelReasons = []
  let readCalls = 0
  let cancelError
  const reader = createStreamReader({
    read() {
      readCalls += 1
      return pending.promise
    },
    cancel(value) {
      cancelReasons.push(value)
    },
  })

  const waiting = reader.read()
  const cancelling = reader.cancel(reason)
  await assert.rejects(waiting, (error) => {
    cancelError = error
    return error.name === "AbortError"
  })
  await cancelling
  assert.deepEqual(cancelReasons, [reason])

  pending.resolve({ done: false, value: "取消后到达" })
  await Promise.resolve()
  await assert.rejects(reader.read(), (error) => error === cancelError)
  await reader.cancel("重复取消")
  assert.equal(readCalls, 1)
  assert.deepEqual(cancelReasons, [reason])
})

test("多块按等待顺序交付，没有等待者时不继续预读", async () => {
  const pending = [deferred(), deferred(), deferred()]
  let readCalls = 0
  const reader = createStreamReader({
    read() {
      const next = pending[readCalls]
      readCalls += 1
      return next.promise
    },
  })

  const first = reader.read()
  const second = reader.read()
  assert.equal(readCalls, 1)

  pending[0].resolve({ done: false, value: "一" })
  assert.deepEqual(await first, { done: false, value: "一" })
  assert.equal(readCalls, 2)

  pending[1].resolve({ done: false, value: "二" })
  assert.deepEqual(await second, { done: false, value: "二" })
  assert.equal(readCalls, 2)

  const third = reader.read()
  assert.equal(readCalls, 3)
  pending[2].resolve({ done: true, value: undefined })
  assert.deepEqual(await third, { done: true, value: undefined })
  assert.equal(readCalls, 3)
})
