// src/usage-cache.mjs —— 额度读取缓存 + 耗尽闸
//
// 为什么需要它：magpie 会为了画卡片频繁调 `usage()`（打开面板、定时刷新、切页）。
// 每次直接打上游的额度接口，轻则慢，重则把接口打爆/触发限流。Loomy 的实测是：
// 成功结果缓存 60 秒，失败只缓存 5 秒 —— 失败不能缓存 60 秒，否则用户点重试
// 也要等一分钟才生效。
//
// 本模块只做「按 key 缓存 + 并发合并 + 两个纯函数」，不读凭据、不发请求。
// 调用方把 `compute` 注入进来（通常是 fetchUsage），key 用凭据身份（session /
// accountId / refresh_token），不要用 provider id —— 同渠道多账号会串。

const DEFAULT_TTL_MS = 60_000
const DEFAULT_FAIL_TTL_MS = 5_000

function assertNonNegative(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`createUsageCache: ${name} 必须是非负有限数字，收到 ${value}`)
  }
}

function assertKey(key) {
  if (typeof key !== "string" || key.trim() === "") {
    throw new TypeError("usage cache 的 key 必须是非空字符串（用凭据身份，不要用 provider id）")
  }
}

/**
 * @param {{
 *   ttlMs?: number,
 *   failTtlMs?: number,
 *   now?: () => number,
 * }} [options]
 */
export function createUsageCache({
  ttlMs = DEFAULT_TTL_MS,
  failTtlMs = DEFAULT_FAIL_TTL_MS,
  now = Date.now,
} = {}) {
  assertNonNegative("ttlMs", ttlMs)
  assertNonNegative("failTtlMs", failTtlMs)
  if (typeof now !== "function") throw new TypeError("createUsageCache: now 必须是函数")

  /** @type {Map<string, { ok: boolean, value?: unknown, error?: unknown, expiresAt: number }>} */
  const entries = new Map()
  /** SWR 后台失败单独短缓存，不能用失败项覆盖 entries 里的成功 stale。 */
  /** @type {Map<string, { error: unknown, expiresAt: number }>} */
  const failures = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const inflight = new Map()

  function sweep() {
    const at = now()
    let removed = 0
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) {
        entries.delete(key)
        removed += 1
      }
    }
    for (const [key, failure] of failures) {
      if (failure.expiresAt <= at) {
        failures.delete(key)
        removed += 1
      }
    }
    return removed
  }

  function start(key, compute, { preserveStale = false } = {}) {
    const pending = inflight.get(key)
    if (pending) return pending

    let task = Promise.resolve()
      .then(compute)
      .then(
        (value) => {
          failures.delete(key)
          entries.set(key, { ok: true, value, expiresAt: now() + ttlMs })
          return value
        },
        (error) => {
          // SWR 失败单独记 failTtl，旧成功值继续作为 stale 返回；普通 read 语义不变。
          if (preserveStale) {
            failures.set(key, { error, expiresAt: now() + failTtlMs })
          } else {
            failures.delete(key)
            entries.set(key, { ok: false, error, expiresAt: now() + failTtlMs })
          }
          throw error
        },
      )
      .finally(() => {
        if (inflight.get(key) === task) inflight.delete(key)
      })
    inflight.set(key, task)
    return task
  }

  return {
    /**
     * 读一个 key 的额度；未命中就执行 compute。
     * 同 key 的并发调用共用同一个 promise，避免面板刷新把接口打两遍。
     */
    read(key, compute) {
      assertKey(key)
      if (typeof compute !== "function") throw new TypeError("usage cache 的 compute 必须是函数")

      sweep()
      const hit = entries.get(key)
      if (hit && hit.expiresAt > now()) {
        if (hit.ok) return Promise.resolve(hit.value)
        return Promise.reject(hit.error)
      }

      return start(key, compute)
    },

    /**
     * stale-while-revalidate：成功旧值过期后也立即返回，并在后台按 key 单飞刷新。
     * 没有成功旧值时等待计算；timeoutMs / signal 只限制等待时间，不取消共享计算。
     */
    readSWR(key, compute, { timeoutMs, signal } = {}) {
      assertKey(key)
      if (typeof compute !== "function") throw new TypeError("usage cache 的 compute 必须是函数")
      if (timeoutMs !== undefined) assertNonNegative("readSWR timeoutMs", timeoutMs)
      if (signal !== undefined && (
        typeof signal?.addEventListener !== "function" || typeof signal?.removeEventListener !== "function"
      )) {
        throw new TypeError("usage cache 的 signal 必须是 AbortSignal")
      }

      // 不能像 read 一样先 sweep：过期成功项正是 SWR 要返回的 stale。
      const hit = entries.get(key)
      if (hit && hit.expiresAt > now()) {
        if (hit.ok) return Promise.resolve(hit.value)
        return Promise.reject(hit.error)
      }

      const stale = hit?.ok ? hit : undefined
      if (!stale && signal?.aborted) {
        return Promise.reject(signal.reason ?? new Error("usage cache 读取已中止"))
      }

      if (stale) {
        const failure = failures.get(key)
        if (failure?.expiresAt > now()) return Promise.resolve(stale.value)
        if (failure) failures.delete(key)
      }

      const task = start(key, compute, { preserveStale: Boolean(stale) })
      if (stale) {
        // 后台失败由这里兜底，既保留旧成功值，也避免无人等待时产生 unhandled rejection。
        void task.catch(() => {})
        return Promise.resolve(stale.value)
      }

      if (timeoutMs === undefined && signal === undefined) return task
      return new Promise((resolve, reject) => {
        let timer
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener("abort", onAbort)
        }
        const onAbort = () => {
          cleanup()
          reject(signal.reason ?? new Error("usage cache 读取已中止"))
        }
        signal?.addEventListener("abort", onAbort, { once: true })
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            cleanup()
            const error = new Error(`usage cache 读取超过 ${timeoutMs}ms`)
            error.name = "TimeoutError"
            reject(error)
          }, timeoutMs)
        }
        // 即使等待已超时/中止，这里仍接收共享计算的最终结果，保证 rejection 有人处理。
        task.then(
          (value) => {
            cleanup()
            resolve(value)
          },
          (error) => {
            cleanup()
            reject(error)
          },
        )
      })
    },

    /** 清一个 key（或全部）的缓存；不动 in-flight，避免把同一次刷新复制成两次。 */
    clear(key) {
      if (key === undefined) {
        entries.clear()
        failures.clear()
        return
      }
      assertKey(key)
      entries.delete(key)
      failures.delete(key)
    },

    /** 清理过期项，返回条数（诊断用） */
    sweep,

    /** 缓存条数（测试/诊断用） */
    get size() {
      return entries.size
    },

    /** 正在执行的读取数（测试/诊断用） */
    get pending() {
      return inflight.size
    },
  }
}

/**
 * 去掉内部字段（`_quota` 等）—— 交给 magpie 的 usage 必须是纯净形状。
 * 只处理顶层，避免误删模型/窗口里的合法下划线字段。
 */
export function publicUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const out = { ...value }
  for (const key of Object.keys(out)) {
    if (key.startsWith("_")) delete out[key]
  }
  return out
}

function balanceNumber(value) {
  const candidates = [value?.balance, value?.remaining, value?.left, value?.available]
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === "") continue
    const n = Number(String(raw).replace(/[^\d.-]/g, ""))
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * 热路径闸：这个账号现在还能发请求吗？
 *
 * 只在「已有读数」且余额 ≤ leadPoints 时返回 true；没有窗口/没有余额字段
 * 或读取失败一律 false（放行）—— 宁可让上游回一次额度不足，也不要因为
 * 本地没读到数就把一个好号挡住。
 */
export function exhausted(value, { leadPoints = 1 } = {}) {
  if (!value || typeof value !== "object" || value.error) return false
  if (!Array.isArray(value.windows) || value.windows.length === 0) return false
  const balance = balanceNumber(value)
  if (balance === undefined) return false
  if (typeof leadPoints !== "number" || !Number.isFinite(leadPoints) || leadPoints < 0) {
    throw new TypeError(`exhausted: leadPoints 必须是非负有限数字，收到 ${leadPoints}`)
  }
  return balance <= leadPoints
}