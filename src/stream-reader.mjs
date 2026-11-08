// 通用 reader 包装：把空闲超时、中止和终态重放与具体数据格式解耦

function doneResult() {
  return { done: true, value: undefined }
}

function abortReason(signal) {
  if (signal?.reason !== undefined) return signal.reason
  const error = new Error("读取已中止")
  error.name = "AbortError"
  return error
}

function timeoutError(timeoutMs) {
  const error = new Error(`读取等待超过 ${timeoutMs}ms`)
  error.name = "TimeoutError"
  error.code = "ERR_STREAM_READ_TIMEOUT"
  return error
}

/**
 * 包装具有 read()、可选 cancel() 的 reader，chunk 可以是任意值。
 *
 * timeoutMs 与 signal 只退出当次等待，不取消底层 reader，也不丢弃或重复发起
 * 已在飞的 reader.read()。等待退出后到达的块仍按序入队，下一次 read 可以拿到。
 * 底层 done/error 是终态：按既有 chunk 顺序交付后广播给所有剩余等待者，
 * 后续 read 仍会持续重放，不再调用 reader.read()。
 * signal 已中止时不会发起底层 read；等待中中止时优先使用 signal.reason 拒绝。
 *
 * 背压策略：只有存在等待者才继续拉取，且最多一个底层 read 在飞。因此包装器
 * 自身没有后台无界预读、高水位或丢块；reader 若自行预读，其内部缓冲仍由它管理。
 * cancel 会使当前及后续 read 以同一个 AbortError 拒绝，忽略在飞 read 的迟到
 * 结果，并最多转发一次到底层 cancel。
 *
 * @param {{
 *   read: () => Promise<{done: boolean, value?: unknown}> | {done: boolean, value?: unknown},
 *   cancel?: (reason?: unknown) => unknown | Promise<unknown>,
 * }} reader
 * @param {{onTimeout?: (error: Error) => void}} [options]
 *   onTimeout 是每次空闲超时的同步通知，回调异常不改变超时结果。
 * @returns {{
 *   read(options?: {timeoutMs?: number, signal?: AbortSignal}): Promise<{done: boolean, value?: unknown}>,
 *   cancel(reason?: unknown): Promise<unknown>,
 * }}
 */
export function createStreamReader(reader, { onTimeout } = {}) {
  if (typeof reader?.read !== "function") {
    throw new TypeError("createStreamReader: reader.read 必须是函数")
  }
  if (onTimeout !== undefined && typeof onTimeout !== "function") {
    throw new TypeError("createStreamReader: onTimeout 必须是函数")
  }

  const slots = []
  const waiters = new Set()
  let inflight = null
  let ended = false
  let failed = false
  let endError
  let cancelled = false
  let cancelPromise = null

  function pump() {
    if (inflight || ended || !waiters.size) return

    let pending
    try {
      pending = reader.read()
    } catch (error) {
      settleError(error)
      return
    }
    inflight = Promise.resolve(pending).then(settleResult, settleError)
  }

  function settleResult(result) {
    inflight = null
    if (cancelled) return
    if (result?.done) ended = true
    slots.push({ ok: true, result })
    flush()
  }

  function settleError(error) {
    inflight = null
    if (cancelled) return
    ended = true
    failed = true
    endError = error
    slots.push({ ok: false, error })
    flush()
  }

  function flush() {
    while (waiters.size && slots.length) {
      const waiter = waiters.values().next().value
      waiters.delete(waiter)
      const slot = slots.shift()
      if (slot.ok) waiter.resolve(slot.result)
      else waiter.reject(slot.error)
    }
    if (ended && !slots.length) {
      for (const waiter of waiters) {
        if (failed) waiter.reject(endError)
        else waiter.resolve(doneResult())
      }
      waiters.clear()
    }
    pump()
  }

  function readNext() {
    if (ended && !slots.length) {
      return {
        promise: failed ? Promise.reject(endError) : Promise.resolve(doneResult()),
        abortWait() {},
      }
    }

    const waiter = {}
    const promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve
      waiter.reject = reject
    })
    waiters.add(waiter)
    flush()
    return {
      promise,
      abortWait() {
        waiters.delete(waiter)
      },
    }
  }

  function read({ timeoutMs, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0)
      ) {
        reject(new TypeError("read: timeoutMs 必须是非负有限数字"))
        return
      }

      let settled = false
      let timer = null
      let abortWait = () => {}

      const finish = (settle, value, abandonWait = false) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        if (abandonWait) abortWait()
        settle(value)
      }
      const onAbort = () => finish(reject, abortReason(signal), true)

      if (signal?.aborted) {
        onAbort()
        return
      }

      const ticket = readNext()
      abortWait = ticket.abortWait
      signal?.addEventListener("abort", onAbort, { once: true })
      // reader.read() 可能同步触发外部副作用，再检查一次避免漏掉中止。
      if (signal?.aborted) onAbort()

      if (timeoutMs !== undefined && !settled) {
        timer = setTimeout(() => {
          const error = timeoutError(timeoutMs)
          finish(reject, error, true)
          try {
            onTimeout?.(error)
          } catch {
            // 通知回调只负责观察，不能覆盖已经确定的超时结果。
          }
        }, timeoutMs)
      }

      ticket.promise.then(
        (result) => finish(resolve, result),
        (error) => finish(reject, error),
      )
    })
  }

  function cancel(reason) {
    if (cancelPromise) return cancelPromise

    cancelled = true
    ended = true
    failed = true
    endError = new Error("读取已取消")
    endError.name = "AbortError"
    slots.length = 0
    for (const waiter of waiters) waiter.reject(endError)
    waiters.clear()

    try {
      cancelPromise = Promise.resolve(
        typeof reader.cancel === "function" ? reader.cancel(reason) : undefined,
      )
    } catch (error) {
      cancelPromise = Promise.reject(error)
    }
    return cancelPromise
  }

  return { read, cancel }
}
