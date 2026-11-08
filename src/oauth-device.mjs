// src/oauth-device.mjs —— OAuth 2.0 Device Authorization Grant（RFC 8628）
//
// 只实现设备码申请、令牌轮询和刷新三个协议原语，不包含任何厂商端点、
// 固定 clientId 或账号业务。deviceAuthUrl / tokenUrl / clientId 均由调用方显式传入。
// fetchImpl 可注入离线实现；now / sleep 仅用于轮询与续期的时间计算和快速测试。

// 令牌寿命的回退值只有一处定义：服务端不给 `expires_in` 时按它算。
// （2026-11-09 实测：`/oauth/token` 明确返回 `expires_in: 1800`。）
import { DEFAULT_EXPIRES_IN } from "./oauth.mjs"

/** RFC 8628 设备码授权的 grant_type */
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

/** 设备码轮询的默认总预算 */
export const DEFAULT_MAX_WAIT_MS = 180_000

function abortError() {
  return Object.assign(new Error("已取消授权"), { name: "AbortError" })
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} 必须是非空字符串`)
  }
  return value
}

/** 可被 AbortSignal 中断的等待。 */
export function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  if (!(ms > 0)) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** 用有引用的计时器兜底：即使注入的 fetch 不遵守 signal，也不能越过总 deadline。 */
function withDeadline(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      settle(value)
    }
    const onAbort = () => finish(reject, abortError())
    const timer = setTimeout(() => {
      finish(reject, Object.assign(new Error("等待授权超时，重新发起授权即可"), { name: "TimeoutError" }))
    }, Math.ceil(ms))
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
  })
}

/**
 * 发送 application/x-www-form-urlencoded POST。
 * 返回值同时保留解析后的 JSON 与截断文本，非 JSON 响应不会在这里抛出。
 */
export async function postForm(url, form, { signal, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("postForm: fetchImpl 必须是函数")

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
    signal,
  })
  const text = await response.text().catch((error) => {
    if (error?.name === "AbortError" || signal?.aborted) throw error
    return ""
  })
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // 非 JSON 的错误页留给调用方放进错误信息
  }
  return { status: response.status, json, text: text.slice(0, 300) }
}

/** 申请设备码，并规范化后续轮询需要的字段。 */
export async function requestDeviceCode({
  deviceAuthUrl,
  tokenUrl,
  clientId,
  signal,
  fetchImpl,
} = {}) {
  requiredString(deviceAuthUrl, "requestDeviceCode: deviceAuthUrl")
  requiredString(tokenUrl, "requestDeviceCode: tokenUrl")
  requiredString(clientId, "requestDeviceCode: clientId")

  const res = await postForm(deviceAuthUrl, { client_id: clientId }, { signal, fetchImpl })
  if (res.status !== 200 || !res.json?.device_code) {
    throw new Error(
      `申请设备授权失败（HTTP ${res.status}）：${res.json?.error_description || res.json?.error || res.text}`,
    )
  }

  const dev = res.json
  return {
    tokenUrl,
    clientId,
    deviceCode: String(dev.device_code),
    userCode: String(dev.user_code || ""),
    verificationUri: String(dev.verification_uri || ""),
    verificationUriComplete: String(dev.verification_uri_complete || ""),
    expiresIn: Number(dev.expires_in) > 0 ? Number(dev.expires_in) : 600,
    interval: Number(dev.interval) > 0 ? Number(dev.interval) : 5,
  }
}

const DEVICE_ERRORS = {
  authorization_pending: "pending",
  slow_down: "slow",
  access_denied: "denied",
  expired_token: "expired",
}

/**
 * 轮询到用户完成授权。
 *
 * 总预算取 min(maxWaitMs, expires_in)，同时约束 sleep 与在飞 token 请求；
 * slow_down 按 RFC 8628 将后续间隔增加 5 秒。
 * authorization_pending 继续等待，access_denied 与 expired_token 分别报错。
 */
export async function pollDeviceToken(dev, {
  signal,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  fetchImpl,
  now = Date.now,
  sleep = wait,
} = {}) {
  requiredString(dev?.tokenUrl, "pollDeviceToken: dev.tokenUrl")
  requiredString(dev?.clientId, "pollDeviceToken: dev.clientId")
  requiredString(dev?.deviceCode, "pollDeviceToken: dev.deviceCode")

  const expiresIn = Number(dev.expiresIn) > 0 ? Number(dev.expiresIn) : 600
  const deadline = now() + Math.min(maxWaitMs, expiresIn * 1000)
  let interval = (Number(dev.interval) > 0 ? Number(dev.interval) : 5) * 1000

  while (now() < deadline) {
    if (signal?.aborted) throw abortError()
    await sleep(Math.min(interval, Math.max(0, deadline - now())), signal)
    if (signal?.aborted) throw abortError()
    const remainingMs = deadline - now()
    if (remainingMs <= 0) break

    const timeoutSignal = AbortSignal.timeout(Math.ceil(remainingMs))
    const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const res = await withDeadline(postForm(
      dev.tokenUrl,
      { grant_type: DEVICE_GRANT, device_code: dev.deviceCode, client_id: dev.clientId },
      { signal: fetchSignal, fetchImpl },
    ), remainingMs, signal)
    if (res.status === 200 && res.json?.access_token) return res.json

    const code = DEVICE_ERRORS[res.json?.error]
    if (code === "pending") continue
    if (code === "slow") {
      interval += 5000
      continue
    }
    if (code === "denied") {
      throw Object.assign(new Error("授权被拒绝"), { signIn: "expired" })
    }
    if (code === "expired") throw new Error("设备码已过期，重新发起授权即可")
    throw new Error(
      `token 请求失败（HTTP ${res.status}）：${res.json?.error_description || res.json?.error || res.text}`,
    )
  }

  throw new Error("等待授权超时，重新发起授权即可")
}

/**
 * 用 refresh_token 换新的 access_token。
 * 上游未轮换 refresh_token 时保留旧值；只有 invalid_grant / expired_token 表示登录失效，
 * 网络错误、5xx 和其他失败返回 null，避免把暂时故障误判成需要重新登录。
 */
export async function refreshAccessToken({
  refresh,
  tokenUrl,
  clientId,
  signal,
  fetchImpl,
  now = Date.now,
} = {}) {
  if (!refresh) return null
  requiredString(tokenUrl, "refreshAccessToken: tokenUrl")
  requiredString(clientId, "refreshAccessToken: clientId")

  const res = await postForm(
    tokenUrl,
    { grant_type: "refresh_token", refresh_token: String(refresh), client_id: clientId },
    { signal, fetchImpl },
  ).catch((error) => {
    if (error?.name === "AbortError" || signal?.aborted) throw error
    return { status: 0, json: null, text: String(error?.message || error) }
  })

  if (res.status >= 400 && (res.json?.error === "invalid_grant" || res.json?.error === "expired_token")) {
    throw Object.assign(
      new Error(`refresh_token 已失效：${res.json?.error_description || res.json.error}`),
      { signIn: "expired" },
    )
  }

  const data = res.json
  if (res.status !== 200 || !data?.access_token) return null
  return {
    access: String(data.access_token),
    refresh: String(data.refresh_token || refresh),
    // ⚠ 寿命是**服务端定的**：`/oauth/token` 的原始响应明确返回 `expires_in: 1800`
    //   （30 分钟，与 JWT 的 `exp - iat` 一致，2026-11-09 实测）。
    //   回退值必须与 `src/oauth.mjs` 的 `DEFAULT_EXPIRES_IN = 1800` 同口径 ——
    //   早期这里写 28_800（8 小时），服务端一旦不给 expires_in，两条路径
    //   就会对同一个令牌给出相差 16 倍的过期时间。
    expires: now() + (Number(data.expires_in) > 0 ? Number(data.expires_in) : DEFAULT_EXPIRES_IN) * 1000,
    clientId: String(data.client_id || clientId),
  }
}
