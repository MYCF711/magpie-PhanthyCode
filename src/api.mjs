// src/api.mjs —— 打云端的那一层：请求头、错误语义、以及唯一的错误出口
//
// 只有这一层知道 Phanthy 云端的形状（`https://code.phanthy.com`）。钩子层不允许
// 直接 fetch —— 否则错误会以十种格式漏到卡片上。
//
// 三个约定：
//   ① 所有请求走 `read()`：非 2xx、非 JSON、业务错误码都变成 `ApiError`
//   ② **模型级错误用 404，不要 401** —— 401 会让 magpie 停掉整个账号
//   ③ 每个请求都带超时；没有超时的 fetch 会挂死整张卡片
//
// 状态码语义（静态观察所得）：
//   401              → 凭据失效（要刷新 / 重登）
//   402              → 额度不足（不杀账号；如实映射，不重试）
//   403 + 套餐文案    → 套餐/订阅问题（`missing_or_expired_plan`、`plan_required` 等）
//   403 其它          → 权限问题，不要当登录失效
//   404              → 模型不可用（只影响这一次请求）
//   429              → 限流，可退避重试
//   5xx              → 上游抖动，可重试

import { CODE_VALUES, CODES, OFFICIAL_CLIENT_SOURCE, OFFICIAL_UA, isLoginBroken } from "./http.mjs"
import { trustedUrlOf } from "./origin.mjs"

/** 云端给的业务错误。带上 status 与 code，调用方才能分流。 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = "", url = "", body } = {}) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.url = url
    this.body = body
  }
}

/** 默认超时：数据类 10s、对话类 120s（流式另算，别套这个） */
export const TIMEOUT = { short: 10_000, long: 120_000, stream: 300_000 }

/**
 * 鉴权头。云端对 `/api/phanthy_code/*`、`/api/oauth/usage` 这类数据端点
 * 用的是 OAuth 的 access token（`Authorization: Bearer`），与模型请求同一个 Bearer。
 *
 * ⚠ UA 用**官方客户端的 UA**（`Bun/1.3.14` + `x-phanthy-client-source: desktop`，
 *   2026-11-09 抓包实测）：
 *   写成 `<包名>/<版本号>` 会被网关按第三方客户端拦（AGENTS 坑 38）。
 */
export function headersFor(auth = {}, extra = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": OFFICIAL_UA,
    "x-phanthy-client-source": OFFICIAL_CLIENT_SOURCE,
  }
  const token = auth?.access || auth?.token || auth?.key
  if (token) headers.authorization = `Bearer ${token}`
  return Object.assign(headers, extra)
}

/**
 * 统一读响应。**所有请求都必须过这里**。
 *
 * 三种失败都变成异常：
 *   HTTP 非 2xx   → ApiError(status, code)
 *   200 但非 JSON → ApiError（带原文前 200 字，否则查不出是什么）
 *   200 是 JSON   → 原样返回
 */
export async function read(res, url = "") {
  const text = await res.text()
  // `redirect:"manual"` 把 3xx 留给这里。必须在 JSON.parse **之前**截住：
  // 真实重定向页通常是 HTML，先解析会落成「status=302 + code 为空」的另一种错误。
  // 统一映射为 502 + upstream_unavailable；既不自动跟随，也不采信 3xx 正文里的
  // `model_not_found` 等词表内 code（它不属于这次重定向的真实语义）。
  if (res.status >= 300 && res.status < 400) {
    const message = `上游返回 HTTP ${res.status} 重定向，已拒绝自动跟随`
    const body = { error: { code: CODES.upstreamUnavailable, message } }
    throw new ApiError(message, { status: 502, code: CODES.upstreamUnavailable, url, body })
  }
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError(`返回的不是 JSON：${text.slice(0, 200)}`, { status: res.status, url })
  }
  if (!res.ok) {
    // 上游可能给 error.code / code，也可能给一整段 error 对象：
    // 只有「字符串且在词表内」才直接采用，其余按状态码映射（R2：code 不能自造）
    const rawCode = body?.error?.code ?? body?.code
    const upstreamCode = typeof rawCode === "string" ? rawCode.trim() : ""
    const code = KNOWN_CODES.has(upstreamCode) ? upstreamCode : errorCodeFor(res.status, body)
    const message =
      String(body?.error?.message ?? body?.message ?? body?.detail ?? "").trim() || `HTTP ${res.status}`
    throw Object.assign(new ApiError(message, { status: res.status, code, url, body }), { upstreamCode })
  }
  return body
}

/**
 * 词表 = `src/http.mjs` 的 CODES（**不另立别名**）。
 * 早期版本在这里额外放行 `quota_exhausted` / `plan_required` 而 ERROR-CODES §3 没登记，
 * 属于「词表外 code」（AGENTS 坑 14 / 审计 F3）；现在两者已进 §3（v1.1），这里只做镜像。
 */
const KNOWN_CODES = new Set(CODE_VALUES)

/**
 * 状态码 → 错误码。词表以 `src/http.mjs` 的 CODES 为准（与 ERROR-CODES §3 一一对应）。
 * `message` 里带套餐文案的 403 要能看出是「套餐」而不是「没登录」。
 *
 * 配对必须与 §3 一致：`invalid_request` 只配 400、`upstream_error` 只配 502、
 * `upstream_unavailable` 只配 503、`model_not_found` 只配 404。
 */
export function errorCodeFor(status, body) {
  const text = `${body?.error?.code ?? ""} ${body?.error?.message ?? ""} ${body?.message ?? ""}`.toLowerCase()
  switch (Number(status)) {
    case 400:
      return /audit|risk|content.?policy|违规|风控/.test(text) ? CODES.auditBlocked : CODES.invalidRequest
    case 401:
      return CODES.sessionExpired
    case 402:
      return CODES.quotaExhausted
    case 403:
      if (/missing_or_expired_plan|no active plan|not subscribed|subscription required|plan_required/.test(text)) {
        return CODES.planRequired
      }
      // 权限 / WAF 类 403：既不是登录失效也不是套餐问题，落 §3 的「默认桶」。
      // status 仍按原值透传（§2：403 不杀账号），不改成 invalid_request（那只配 400）。
      return CODES.upstreamError
    case 404:
      return CODES.modelNotFound
    case 409:
      // 409 也可能来自注册端点的账号级设备绑定 —— 那条由 production-auth.mjs 自己构造
      return CODES.concurrencyConflict
    case 429:
      return CODES.rateLimited
    case 501:
      return CODES.notImplemented
    case 504:
      return CODES.upstreamTimeout
    default:
      if (Number(status) >= 500) return CODES.upstreamUnavailable
      return CODES.invalidRequest
  }
}

/** 带超时的 fetch + 统一读法。数据类请求都走它。 */
export async function get(path, auth, { timeout = TIMEOUT.short, method = "GET", body, headers, fetchImpl = globalThis.fetch, signal } = {}) {
  // 出口守卫：绝对 URL 必须是 BASE 的 https origin；相对路径拼好后同样再验一遍
  // （见 `src/origin.mjs`）。这个函数会把 `Authorization: Bearer` 一起发出去，
  // 所以「发到哪台主机」必须在发请求之前定死。
  const url = trustedUrlOf(path).href
  const timeoutSignal = AbortSignal.timeout(timeout)
  const res = await fetchImpl(url, {
    method,
    headers: headersFor(auth, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
    // ⚠ L-5：**不许自动跟随 3xx**。跨站 302 时 undici 会剥掉 `authorization`，
    //   但**会转发** `x-desktop-*` 签名头 / 指纹头 —— 不跟就是最省事的防线。
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  })
  return read(res, url)
}

/**
 * 把「这个模型不行」翻译成 404 —— 钩子层的铁律。
 *
 * magpie 的语义：401 → 整个账号停用；404 → 只搁置这个模型；其它 → 透传。
 * §3 规定 404 必须配 `model_not_found`：不能把上游给的任意 code（比如 400 的
 * `invalid_request`）原样搬到 404 上，那会让「参数错」看起来像「模型不存在」。
 */
export function asModelError(e, modelId = "") {
  if (!(e instanceof ApiError)) return e
  const looksLikeModel = /model|模型|not found|不存在|no access|未开通/i.test(String(e.message))
  if (looksLikeModel) {
    return Object.assign(
      new ApiError(e.message, { status: 404, code: CODES.modelNotFound, url: e.url, body: e.body }),
      { modelId },
    )
  }
  return e
}

/** 登录态真的失效时才用这个 —— 误判一次用户就要重登。 */
export function asSignInExpired(message = "登录已失效") {
  return Object.assign(new Error(message), { signIn: "expired" })
}

/** 上游 401/403 必须带明确登录语义才算失效；模型权限 / WAF 403 不误杀账号。 */
export function isAuthFailure(e) {
  return e instanceof ApiError && isLoginBroken(e.status, e.body ?? e.message)
}

/** 额度不足 / 套餐到期：这两个不该被当成「登录失效」重试。 */
export function isQuotaRefusal(e) {
  if (!(e instanceof ApiError)) return false
  if (e.status === 402) return true
  return e.code === CODES.planRequired || e.code === CODES.quotaExhausted
}
