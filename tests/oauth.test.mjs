// tests/oauth.test.mjs —— 授权地址 / 换票 / 续期 / 错误分类（离线，注入 fetch）

import test from "node:test"
import assert from "node:assert/strict"

import { BASE } from "../src/context.mjs"
import {
  AUTHORIZE_PATH,
  CLIENT_ID,
  OAuthError,
  SCOPES,
  TOKEN_PATH,
  authorizationCodeForm,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  isCredentialRejected,
  parseTokenResponse,
  refreshAccessToken,
  refreshForm,
} from "../src/oauth.mjs"

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function recorder(response) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return typeof response === "function" ? response() : response
  }
  return { calls, fetchImpl }
}

test("授权地址：client_id / PKCE / scope / state / redirect_uri 全在 query 里", () => {
  const url = new URL(
    buildAuthorizeUrl({
      redirectUri: "http://127.0.0.1:51234/oauth/callback",
      state: "state-test",
      codeChallenge: "challenge-test",
    }),
  )
  assert.equal(`${url.origin}${url.pathname}`, `${BASE}${AUTHORIZE_PATH}`)
  const q = url.searchParams
  assert.equal(q.get("response_type"), "code")
  assert.equal(q.get("client_id"), CLIENT_ID)
  assert.equal(q.get("client_id"), "phanthy-code-cli")
  assert.equal(q.get("redirect_uri"), "http://127.0.0.1:51234/oauth/callback")
  assert.equal(q.get("state"), "state-test")
  assert.equal(q.get("code_challenge"), "challenge-test")
  assert.equal(q.get("code_challenge_method"), "S256")
  assert.equal(q.get("scope"), SCOPES.join(" "))
  assert.match(q.get("scope"), /user:inference/)
})

test("授权地址：缺 redirect_uri / state / challenge 直接抛 TypeError", () => {
  assert.throws(() => buildAuthorizeUrl({ state: "s", codeChallenge: "c" }), TypeError)
  assert.throws(() => buildAuthorizeUrl({ redirectUri: "http://x/cb", codeChallenge: "c" }), TypeError)
  assert.throws(() => buildAuthorizeUrl({ redirectUri: "http://x/cb", state: "s" }), TypeError)
})

test("换票表单字段与官方一致（form-urlencoded，不是 JSON）", () => {
  const form = authorizationCodeForm({
    code: "code-test",
    state: "state-test",
    codeVerifier: "verifier-test",
    redirectUri: "http://127.0.0.1:1/oauth/callback",
  })
  assert.equal(form.get("grant_type"), "authorization_code")
  assert.equal(form.get("client_id"), "phanthy-code-cli")
  assert.equal(form.get("code"), "code-test")
  assert.equal(form.get("state"), "state-test")
  assert.equal(form.get("code_verifier"), "verifier-test")
  assert.equal(form.get("redirect_uri"), "http://127.0.0.1:1/oauth/callback")
})

test("换票：POST 到 /oauth/token，content-type 是 form，响应归一成凭据", async () => {
  const { calls, fetchImpl } = recorder(
    jsonResponse({ access_token: "access-test", refresh_token: "refresh-test", expires_in: 1800, scope: "user:inference" }),
  )
  const before = Date.now()
  const token = await exchangeAuthorizationCode({
    code: "code-test",
    state: "state-test",
    codeVerifier: "verifier-test",
    redirectUri: "http://127.0.0.1:1/oauth/callback",
    fetchImpl,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${BASE}${TOKEN_PATH}`)
  assert.equal(calls[0].init.method, "POST")
  // L-5：换票是带 refresh_token / code 的写入面，绝不能自动跟随 3xx 到别的站点
  assert.equal(calls[0].init.redirect, "manual")
  assert.match(String(calls[0].init.headers["content-type"]), /application\/x-www-form-urlencoded/)
  assert.match(String(calls[0].init.body), /grant_type=authorization_code/)
  assert.match(String(calls[0].init.body), /code_verifier=verifier-test/)

  assert.equal(token.access, "access-test")
  assert.equal(token.refresh, "refresh-test")
  assert.equal(token.expiresIn, 1800)
  assert.ok(token.expires >= before + 1800 * 1000)
})

test("续期：grant_type=refresh_token，响应没有新 refresh 时返回空串让调用方沿用旧值", async () => {
  const { calls, fetchImpl } = recorder(jsonResponse({ access_token: "access-2" }))
  const token = await refreshAccessToken({ refreshToken: "refresh-test", fetchImpl })

  assert.match(String(calls[0].init.body), /grant_type=refresh_token/)
  assert.match(String(calls[0].init.body), /refresh_token=refresh-test/)
  assert.equal(calls[0].init.redirect, "manual", "续期同样不许自动跟随 3xx")
  assert.equal(token.access, "access-2")
  assert.equal(token.refresh, "", "缺 refresh_token 时不能编一个值")
  assert.equal(token.expiresIn, 1800, "缺 expires_in 时按官方默认 30 分钟")
})

test("换票失败：非 2xx 变成 OAuthError，带 status 与 error code", async () => {
  const { fetchImpl } = recorder(jsonResponse({ error: "invalid_grant", error_description: "code 已用过" }, 400))
  await assert.rejects(
    () => refreshAccessToken({ refreshToken: "r", fetchImpl }),
    (error) => {
      assert.ok(error instanceof OAuthError)
      assert.equal(error.status, 400)
      assert.equal(error.code, "invalid_grant")
      assert.match(error.message, /code 已用过/, "错误消息要保留上游原文")
      return true
    },
  )
})

test("换票失败：非 JSON 也变成 OAuthError（不是「静默空对象」）", async () => {
  const { fetchImpl } = recorder(new Response("<html>gateway</html>", { status: 200 }))
  assert.throws(() => parseTokenResponse(undefined), OAuthError)
  await assert.rejects(
    () => refreshAccessToken({ refreshToken: "r", fetchImpl }),
    (error) => error instanceof OAuthError && error.code === "upstream_error",
  )
})

test("凭据失效的分类：invalid_grant 才算，5xx 不算", () => {
  assert.equal(isCredentialRejected(new OAuthError("x", { status: 400, code: "invalid_grant" })), true)
  assert.equal(isCredentialRejected(new OAuthError("x", { status: 401, code: "invalid_client" })), true)
  assert.equal(isCredentialRejected(new OAuthError("x", { status: 503, code: "service_unavailable" })), false)
  assert.equal(isCredentialRejected(new Error("boom")), false)
})

test("token 响应缺 access_token → 抛错，不返回半条凭据", () => {
  assert.throws(() => parseTokenResponse({ refresh_token: "r" }), OAuthError)
})
