import test from "node:test"
import assert from "node:assert/strict"

import {
  CODES,
  OFFICIAL_UA,
  baseHeaders,
  jsonResponse,
  errorResponse,
  upstreamError,
  readBody,
  errorText,
  abortSignal,
  retryAfter,
  isLoginBroken,
} from "../src/http.mjs"

test("CODES 提供稳定且不可变的错误码词表", () => {
  assert.equal(CODES.signInRequired, "sign_in_required")
  assert.equal(CODES.modelNotFound, "model_not_found")
  assert.equal(CODES.upstreamTimeout, "upstream_timeout")
  // ERROR-CODES §3 v1.1 登记的三条（审计 F3/F21：词表外 code 不能自造，必须进 §3）
  assert.equal(CODES.quotaExhausted, "quota_exhausted")
  assert.equal(CODES.planRequired, "plan_required")
  assert.equal(CODES.deviceBindingConflict, "device_binding_conflict")
  assert.equal(Object.isFrozen(CODES), true)
  assert.throws(() => {
    CODES.rateLimited = "changed"
  }, TypeError)
})

test("baseHeaders 用官方客户端 UA 作默认值，并允许调用方覆盖默认头", () => {
  // 默认值必须是**官方客户端**的 UA：`<包名>/<版本号>` 会被上游网关按
  // 「第三方客户端」拦成 403 TM.00000001（文案是「网络繁忙」）。见 AGENTS 坑 38。
  // 本服务的官方客户端是 Bun 编译的二进制，2026-11-09 抓包实测 UA 就是
  // `Bun/1.3.14` —— 反直觉，但早期 `phanthy-code-cli/2.1.0` 已被实测否证。
  assert.deepEqual(baseHeaders(), {
    "user-agent": OFFICIAL_UA,
    "x-phanthy-client-source": "desktop",
    accept: "application/json",
  })
  assert.equal(OFFICIAL_UA, "Bun/1.3.14")
  assert.match(OFFICIAL_UA, /^Bun\/\d+\.\d+\.\d+$/)
  assert.ok(!OFFICIAL_UA.startsWith("magpie"))
  assert.deepEqual(baseHeaders({ "user-agent": "vendor/1.2", accept: "text/event-stream", origin: "https://example.com" }), {
    "user-agent": "vendor/1.2",
    "x-phanthy-client-source": "desktop",
    accept: "text/event-stream",
    origin: "https://example.com",
  })
})

test("jsonResponse 返回 JSON，并允许覆盖 Content-Type", async () => {
  const response = jsonResponse({ ok: true }, 201, { "x-request-id": "req-1" })
  assert.equal(response.status, 201)
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8")
  assert.equal(response.headers.get("x-request-id"), "req-1")
  assert.deepEqual(await response.json(), { ok: true })

  const custom = jsonResponse({ ok: false }, 200, { "content-type": "application/problem+json" })
  assert.equal(custom.headers.get("content-type"), "application/problem+json")
})

test("errorResponse 保持 OpenAI 错误形状、status、code 与登录响应头", async () => {
  const response = errorResponse("  token expired  ", 401, CODES.sessionExpired, {
    signIn: "expired",
    "x-request-id": "req-2",
  })
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("x-magpie-sign-in"), "expired")
  assert.equal(response.headers.get("x-request-id"), "req-2")
  assert.equal(response.headers.get("signIn"), null)
  assert.deepEqual(await response.json(), {
    error: {
      message: "token expired",
      type: "session_expired",
      code: "session_expired",
      status: 401,
    },
  })
})

test("errorResponse 给空消息默认文案，且没有 signIn 时不加登录头", async () => {
  const response = errorResponse("   ", 502, CODES.upstreamError)
  assert.equal(response.headers.get("x-magpie-sign-in"), null)
  assert.deepEqual(await response.json(), {
    error: {
      message: "上游没有返回内容",
      type: "upstream_error",
      code: "upstream_error",
      status: 502,
    },
  })
})

test("upstreamError 保留消息，并按需附加 status", () => {
  const error = upstreamError("upstream failed", 503)
  assert.ok(error instanceof Error)
  assert.equal(error.message, "upstream failed")
  assert.equal(error.status, 503)

  const withoutStatus = upstreamError(null)
  assert.equal(withoutStatus.message, "")
  assert.equal("status" in withoutStatus, false)
})

test("readBody 解析 JSON，并保留 HTML 等非 JSON 原文", async () => {
  assert.deepEqual(await readBody(new Response('{"error":{"message":"bad"}}')), {
    error: { message: "bad" },
  })
  assert.deepEqual(await readBody(new Response("<html>blocked</html>")), {
    _text: "<html>blocked</html>",
  })
})

test("readBody 对空 body 和读取失败返回空对象", async () => {
  assert.deepEqual(await readBody(new Response(null)), {})
  assert.deepEqual(await readBody({ text: async () => { throw new Error("read failed") } }), {})
})

test("errorText 汇总常见字段、展开嵌套错误并限制长度", () => {
  assert.equal(errorText(null), "")
  assert.equal(errorText("plain error"), "plain error")
  assert.equal(errorText({ message: "bad", error: { code: "E1" }, detail: "detail" }), 'bad · {"code":"E1"} · detail')
  assert.equal(errorText("x".repeat(500)).length, 400)
})

test("errorText 将 HTML 转成可读文本", () => {
  const text = errorText({ _text: "<html><body>Cloudflare   blocked</body></html>" })
  assert.match(text, /Cloudflare blocked/)
  assert.doesNotMatch(text, /<[^>]+>/)
  assert.equal(errorText({ _text: "x".repeat(500) }).length, 300)
})

test("abortSignal 优先使用调用方 signal", () => {
  const supplied = AbortSignal.abort("stop")
  assert.equal(abortSignal(supplied, 10), supplied)
  assert.equal(supplied.aborted, true)
  assert.equal(supplied.reason, "stop")
})

test("abortSignal 仅在无调用方 signal 且超时有效时创建超时信号", () => {
  const timeout = abortSignal(undefined, 1000)
  assert.ok(timeout instanceof AbortSignal)
  assert.equal(timeout.aborted, false)
  assert.equal(abortSignal(undefined, 0), undefined)
  assert.equal(abortSignal(undefined, -1), undefined)
  assert.equal(abortSignal(undefined, "invalid"), undefined)
})

test("retryAfter 支持秒数与 HTTP-date，并钳制在 1–60 秒", () => {
  const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")
  const response = (value) => new Response(null, { headers: value === null ? {} : { "retry-after": value } })
  assert.equal(retryAfter(response("2")), 2000)
  assert.equal(retryAfter(response("120")), 60_000)
  assert.equal(retryAfter(response("0")), 1000)
  assert.equal(retryAfter(response("-10")), 1000, "过去时间的等待不能小于 1 秒")
  assert.equal(retryAfter(response(new Date(now + 3000).toUTCString()), 0, { now: () => now }), 3000)
  assert.equal(retryAfter(response(new Date(now - 3000).toUTCString()), 0, { now: () => now }), 1000)
})

test("retryAfter 对缺失和非法值使用 5s → 20s → 20s", () => {
  const response = new Response(null)
  assert.equal(retryAfter(response, 0), 5000)
  assert.equal(retryAfter(response, 1), 20_000)
  assert.equal(retryAfter(response, 2), 20_000)
  assert.equal(retryAfter(new Response(null, { headers: { "retry-after": "not-a-date" } }), 0), 5000)
})

const unservedModelMessages = [
  "模型不存在",
  "模型不可用",
  "模型未开通",
  "无权访问该模型",
  "模型不支持",
  "model_not_found: model is not available",
]

for (const message of unservedModelMessages) {
  test(`isLoginBroken 不让 401 的纯模型错误杀账号：${message}`, () => {
    assert.equal(isLoginBroken(401, { message }), false)
  })
}

test("isLoginBroken 的 401 鉴权文案优先于模型错误", () => {
  for (const message of unservedModelMessages) {
    assert.equal(isLoginBroken(401, { message: `${message}: invalid token` }), true)
  }
  assert.equal(isLoginBroken(401, { message: "model access denied: invalid token" }), true)
  assert.equal(isLoginBroken("401", { message: "session expired" }), true)
})

test("isLoginBroken 仅对明确登录文本的 403 判定 expired", () => {
  assert.equal(isLoginBroken(403, { message: "not_logged_in" }), true)
  assert.equal(isLoginBroken(403, { message: "CSRF validation failed" }), true)
  assert.equal(isLoginBroken(403, { message: "未登录" }), true)
  assert.equal(isLoginBroken(403, { message: "model permission denied" }), false)
  assert.equal(isLoginBroken(403, { _text: "<html>Cloudflare bot blocked</html>" }), false)
})

test("isLoginBroken 对其它状态、HTML 和空 body 保持 false", async () => {
  assert.equal(isLoginBroken(404, { message: "login required" }), false)
  assert.equal(isLoginBroken(500, { message: "session expired" }), false)
  assert.equal(isLoginBroken(403, await readBody(new Response("<html>access denied</html>"))), false)
  assert.equal(isLoginBroken(403, await readBody(new Response(null))), false)
})
