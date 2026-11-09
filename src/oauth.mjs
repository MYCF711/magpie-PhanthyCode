// src/oauth.mjs —— Phanthy 云端 OAuth 2.1（授权码 + PKCE S256）
//
// 只管三件事：拼授权地址、换票、续期。协议原语（PKCE / loopback 回调）在
// `src/oauth-pkce.mjs` 里，这里不重复实现。
//
// 证据：`claude-sidecar.exe` @`100006200`–`100011500` 与
// `_up_\dist\assets\App-Y9eSJNhB.js` 的 `phanthy_code` / `phanthy_work` 产品表：
//   client_id   = phanthy-code-cli
//   websiteOrigin / base = https://code.phanthy.com
//   redirect_uri = http://127.0.0.1:<随机端口>/oauth/callback
//   scope        = 见下方 SCOPES（按空格连接）
//   grant_type   = authorization_code | refresh_token，form-urlencoded
//
// ⚠ 一个已知的静态不确定项：`/oauth/authorize` 这个字面量在 Phanthy 侧没有被
//   独立扫到（只扫到 Codex 构建器与本地配置构建器里的同名路径）。前端是把
//   `websiteOrigin` 拼上路径来用，所以这里按 `${base}/oauth/authorize` 拼，
//   并且把路径做成常量 —— 若真实路径不同，只改 AUTHORIZE_PATH 一处。
//
// ⚠ 换票响应里没有 profile，所以插件拿不到邮箱/昵称。凭据身份用
//   access/refresh 的 sha256 指纹（见 `src/credential.mjs` 的 `fingerprint`），
//   卡片显示名交给宿主回退成供应商名 —— 不要拿内部 id 冒充账号名。

import { BASE } from "./context.mjs"
import { trustedUrlOf } from "./origin.mjs"

/** 公开的 OAuth 客户端 id（桌面端也用同一个） */
export const CLIENT_ID = "phanthy-code-cli"

/** 授权范围：按空格连接后放进 `scope` 参数 */
export const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
]

/** 授权端点路径（见文件头的已知不确定项） */
export const AUTHORIZE_PATH = "/oauth/authorize"

/** 换票 / 续期端点路径 */
export const TOKEN_PATH = "/oauth/token"

/** loopback 回调路径，与官方客户端的 redirect_uri 一致 */
export const CALLBACK_PATH = "/oauth/callback"

/** 默认授权码有效期余量：expires_in 缺失时按 30 分钟算（官方默认 1800） */
export const DEFAULT_EXPIRES_IN = 1800

/** OAuth 端点返回的错误。`code` 优先取 body.error，其次 HTTP 状态。 */
export class OAuthError extends Error {
  constructor(message, { status = 0, code = "", body } = {}) {
    super(message)
    this.name = "OAuthError"
    this.status = status
    this.code = code
    this.body = body
  }
}

function trimmedBase(base) {
  const value = String(base ?? BASE).trim()
  return value.endsWith("/") ? value.slice(0, -1) : value
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} 必须是非空字符串`)
  }
  return value
}

/**
 * 拼授权地址。**不要在这里发请求** —— 宿主会把它交给浏览器打开。
 *
 * @param {{
 *   base?: string,
 *   redirectUri: string,
 *   state: string,
 *   codeChallenge: string,
 *   scope?: string[]|string,
 *   extra?: Record<string,string>,
 * }} options
 * @returns {string}
 */
export function buildAuthorizeUrl({ base = BASE, redirectUri, state, codeChallenge, scope = SCOPES, extra = {} } = {}) {
  requiredString(redirectUri, "buildAuthorizeUrl: redirectUri")
  requiredString(state, "buildAuthorizeUrl: state")
  requiredString(codeChallenge, "buildAuthorizeUrl: codeChallenge")

  const url = trustedUrlOf(AUTHORIZE_PATH, { base: trimmedBase(base) })
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", Array.isArray(scope) ? scope.join(" ") : String(scope))
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/** 换票请求体：form-urlencoded，字段顺序按官方客户端（服务端不保证关心顺序） */
export function authorizationCodeForm({ code, state, codeVerifier, redirectUri } = {}) {
  const form = new URLSearchParams()
  form.set("grant_type", "authorization_code")
  form.set("client_id", CLIENT_ID)
  form.set("code", requiredString(code, "authorizationCodeForm: code"))
  form.set("state", requiredString(state, "authorizationCodeForm: state"))
  form.set("code_verifier", requiredString(codeVerifier, "authorizationCodeForm: codeVerifier"))
  form.set("redirect_uri", requiredString(redirectUri, "authorizationCodeForm: redirectUri"))
  return form
}

/** 续期请求体 */
export function refreshForm({ refreshToken } = {}) {
  const form = new URLSearchParams()
  form.set("grant_type", "refresh_token")
  form.set("client_id", CLIENT_ID)
  form.set("refresh_token", requiredString(refreshToken, "refreshForm: refreshToken"))
  return form
}

/**
 * 把换票响应归一成 magpie 的凭据字段。
 *
 * ⚠ `refresh_token` 不是每次都有（服务端可能不轮换）：缺失时调用方要沿用旧值，
 * 不能覆盖成空串，否则用户会被要求重新登录。
 */
export function parseTokenResponse(body) {
  const access = typeof body?.access_token === "string" ? body.access_token.trim() : ""
  if (!access) {
    throw new OAuthError("换票响应里没有 access_token", {
      status: 200,
      code: String(body?.error ?? "missing_access_token"),
      body,
    })
  }
  const refresh = typeof body?.refresh_token === "string" ? body.refresh_token.trim() : ""
  const expiresIn = Number(body?.expires_in)
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN
  return {
    access,
    refresh,
    expires: Date.now() + ttl * 1000,
    expiresIn: ttl,
    scope: typeof body?.scope === "string" ? body.scope : "",
  }
}

/**
 * 打一次 token 端点。非 2xx、非 JSON、缺少 access_token 都变成 OAuthError，
 * 让调用方在一处决定「这是登录失效还是上游抖动」。
 */
export async function requestToken({
  base = BASE,
  form,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  signal,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("requestToken: fetchImpl 必须是函数")
  if (!(form instanceof URLSearchParams)) throw new TypeError("requestToken: form 必须是 URLSearchParams")

  // ⚠ 换票请求体里带 authorization_code / refresh_token：URL 必须过 origin 闸门
  //   （https + 无 userinfo + 与 BASE 同 origin），不能拿字符串直接拼。
  const url = trustedUrlOf(TOKEN_PATH, { base: trimmedBase(base) }).toString()
  const timeout = AbortSignal.timeout(timeoutMs)
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form.toString(),
    // ⚠ L-5：换票请求体里带 authorization_code / refresh_token，绝不能自动
    //   跟随跨站 3xx（undici 会剥 authorization，但挂在这条通道上的凭据更不该出网）。
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })

  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new OAuthError(`换票端点返回的不是 JSON：${text.slice(0, 200)}`, {
      status: res.status,
      code: "upstream_error",
    })
  }

  if (!res.ok) {
    const code = String(body?.error ?? body?.code ?? `http_${res.status}`)
    const detail = String(body?.error_description ?? body?.message ?? "").trim()
    throw new OAuthError(detail || `换票失败（HTTP ${res.status}）`, { status: res.status, code, body })
  }

  return body
}

/** 授权码换票 */
export async function exchangeAuthorizationCode({
  code,
  state,
  codeVerifier,
  redirectUri,
  base = BASE,
  fetchImpl,
  timeoutMs,
  signal,
} = {}) {
  const body = await requestToken({
    base,
    form: authorizationCodeForm({ code, state, codeVerifier, redirectUri }),
    fetchImpl,
    timeoutMs,
    signal,
  })
  return parseTokenResponse(body)
}

/** refresh_token 续期 */
export async function refreshAccessToken({ refreshToken, base = BASE, fetchImpl, timeoutMs, signal } = {}) {
  const body = await requestToken({
    base,
    form: refreshForm({ refreshToken }),
    fetchImpl,
    timeoutMs,
    signal,
  })
  return parseTokenResponse(body)
}

/**
 * 这个错误是不是「凭据真的废了」。
 *
 * 只有 `invalid_grant` 这一类才允许抛 `signIn: "expired"`（用户要重新登录一次）；
 * 网络错误、5xx、429 都只是抖动，重试即可 —— 误判一次用户就得重登。
 */
export function isCredentialRejected(error) {
  if (!(error instanceof OAuthError)) return false
  const code = String(error.code ?? "").toLowerCase()
  if (code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client") return true
  if (error.status === 400 || error.status === 401) {
    return /invalid_grant|expired|revoked|invalid_token/i.test(`${code} ${error.message}`)
  }
  return false
}
