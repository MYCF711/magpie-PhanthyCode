import test from "node:test"
import assert from "node:assert/strict"

import {
  classifyRefusal,
  isChannelDown,
  isModelUnserved,
  isMoneyRefusal,
  isUpstreamTimeout,
  isUpstreamUnavailable,
  rewriteRefusal,
  upstreamText,
} from "../src/status.mjs"

/** 直接给 body 访问和读取方法计数，不把运行时的底层流预取算成改写读流 */
function streamedResponse(status, text) {
  const response = new Response(text, { status })
  let pulls = 0
  const readText = response.text.bind(response)
  response.text = () => {
    pulls += 1
    return readText()
  }
  const body = response.body
  Object.defineProperty(response, "body", {
    configurable: true,
    get() {
      pulls += 1
      return body
    },
  })
  return { response, pulls: () => pulls }
}

test("200 SSE 返回原对象，改写前零 body pull，之后仍可读", async () => {
  const sse = 'event: message\ndata: {"choices":[]}\n\ndata: [DONE]\n\n'
  const { response, pulls } = streamedResponse(200, sse)
  response.clone = () => {
    throw new Error("非 400/422 不应 clone")
  }

  const result = await rewriteRefusal(response)
  assert.strictEqual(result, response)
  assert.equal(pulls(), 0)
  assert.equal(response.bodyUsed, false)
  assert.equal(await result.text(), sse)
  assert.ok(pulls() > 0)
})

for (const status of [401, 403, 429, 500, 502, 503]) {
  test(`${status} 返回原对象，零 body pull 且之后仍可读`, async () => {
    const text = `upstream status ${status}`
    const { response, pulls } = streamedResponse(status, text)
    response.clone = () => {
      throw new Error("非 400/422 不应 clone")
    }

    const result = await rewriteRefusal(response)
    assert.strictEqual(result, response)
    assert.equal(pulls(), 0)
    assert.equal(response.bodyUsed, false)
    assert.equal(await result.text(), text)
    assert.ok(pulls() > 0)
  })
}

const unchangedCases = [
  [400, '{"error":{"code":"invalid_schema","message":"tool schema is invalid"}}', "schema"],
  [422, '{"error":{"code":"context_length_exceeded","message":"maximum context exceeded"}}', "context"],
  [400, '{"error":{"message":"max_tokens is above the allowed value"}}', "max_tokens"],
]

for (const [status, text, name] of unchangedCases) {
  test(`${status} 的 ${name} 错误保持原对象和原文`, async () => {
    const response = new Response(text, { status })
    assert.equal(classifyRefusal(status, text), 0)

    const result = await rewriteRefusal(response)
    assert.strictEqual(result, response)
    assert.equal(response.bodyUsed, false)
    assert.equal(await result.text(), text)
  })
}

test("请求过长优先于其它分类，保持原状态", () => {
  const text = "max_tokens exceeded; insufficient balance; upstream timeout; upstream temporarily unavailable; bad response status code; model_not_found; rate limit"
  assert.equal(classifyRefusal(400, text), 0)
  assert.equal(classifyRefusal(422, text), 0)
})

test("money、channel、model、rate 按顺序决定优先级", async () => {
  const cases = [
    {
      text: "insufficient balance; upstream timeout; upstream temporarily unavailable; bad response status code; model_not_found; rate limit",
      mapped: 402,
      reason: "Payment Required",
    },
    {
      text: "bad response status code 400; model_not_found; rate limit",
      mapped: 502,
      reason: "Bad Gateway",
    },
    {
      text: "model_not_found; rate limit exceeded",
      mapped: 404,
      reason: "Not Found",
    },
    {
      text: "rate limit exceeded",
      mapped: 429,
      reason: "Too Many Requests",
    },
  ]

  for (const status of [400, 422]) {
    for (const { text, mapped, reason } of cases) {
      assert.equal(classifyRefusal(status, text), mapped)
      const original = new Response(text, { status })
      const result = await rewriteRefusal(original)
      assert.notStrictEqual(result, original)
      assert.equal(result.status, mapped)
      assert.equal(result.statusText, reason)
      assert.equal(result.headers.get("x-magpie-vendor-status"), String(status))
      assert.equal(await result.text(), text)
      assert.equal(original.bodyUsed, false)
      assert.equal(await original.text(), text)
    }
  }
})

const upstreamStatusCases = [
  { kind: "timeout", text: "upstream timeout", mapped: 504, reason: "Gateway Timeout" },
  { kind: "unavailable", text: "upstream temporarily unavailable", mapped: 503, reason: "Service Unavailable" },
  { kind: "channel", text: "bad response status code", mapped: 502, reason: "Bad Gateway" },
]

for (const status of [400, 422]) {
  for (const { kind, text, mapped, reason } of upstreamStatusCases) {
    test(`${status} 的 ${kind} 映射为 ${mapped}，原响应仍可读`, async () => {
      assert.equal(classifyRefusal(status, text), mapped)
      const original = new Response(text, { status })
      const result = await rewriteRefusal(original)
      assert.notStrictEqual(result, original)
      assert.equal(result.status, mapped)
      assert.equal(result.statusText, reason)
      assert.equal(result.headers.get("x-magpie-vendor-status"), String(status))
      assert.equal(await result.text(), text)
      assert.equal(original.bodyUsed, false)
      assert.equal(await original.text(), text)
    })
  }
}

test("其它 400/422 非 JSON 文本原样放行", async () => {
  for (const status of [400, 422]) {
    const text = "invalid request: field is not supported"
    const response = new Response(text, { status })
    const result = await rewriteRefusal(response)
    assert.strictEqual(result, response)
    assert.equal(response.bodyUsed, false)
    assert.equal(await result.text(), text)
  }
})

test("改写只读取 clone，原 response 仍可读", async () => {
  const text = "insufficient balance"
  const original = new Response(text, { status: 400 })
  const result = await rewriteRefusal(original)

  assert.notStrictEqual(result, original)
  assert.equal(original.bodyUsed, false)
  assert.equal(await original.text(), text)
  assert.equal(await result.text(), text)
})

test("改写后清理实体头并记录通用上游状态头", async () => {
  const original = new Response("no available channels", {
    status: 422,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": "999",
      "content-encoding": "gzip",
      "x-request-id": "request-123",
      "x-magpie-vendor-status": "stale",
    },
  })
  const result = await rewriteRefusal(original)

  assert.equal(result.status, 502)
  assert.equal(result.headers.get("content-length"), null)
  assert.equal(result.headers.get("content-encoding"), null)
  assert.equal(result.headers.get("content-type"), "text/plain; charset=utf-8")
  assert.equal(result.headers.get("x-request-id"), "request-123")
  assert.equal(result.headers.get("x-magpie-vendor-status"), "422")
})

test("HTML 摘要只留 title 与 status，不泄漏整页", () => {
  const html = `<!doctype html><html><head><title>Access denied</title><style>secret-style</style></head><body>secret-body ${"x".repeat(500)}</body></html>`
  const summary = upstreamText(html, 403)
  assert.equal(summary, "上游返回 HTML 错误页（Access denied），不是接口响应（HTTP 403）")
  assert.ok(!summary.includes("secret-style"))
  assert.ok(!summary.includes("secret-body"))
  assert.ok(!summary.includes("<html"))

  assert.equal(
    upstreamText("<html><head><title>503</title></head><body>hidden</body></html>", 503),
    "上游返回 HTML 错误页，不是接口响应（HTTP 503）",
  )
})

test("普通非 JSON 文本去空白并截断到 200 字", () => {
  assert.equal(upstreamText("  Allow: POST, PUT  ", 405), "Allow: POST, PUT")
  assert.equal(upstreamText("x".repeat(240), 500), "x".repeat(200))
  assert.equal(upstreamText(null, 500), "")
})

test("分类谓词识别通用错误文案，并区分超时、暂不可用与渠道异常", () => {
  assert.equal(isMoneyRefusal("insufficient balance"), true)
  assert.equal(isUpstreamTimeout("上游服务超时"), true)
  assert.equal(isUpstreamUnavailable("上游服务暂时不可用"), true)
  assert.equal(isChannelDown("no available channels"), true)
  assert.equal(isChannelDown("upstream timeout"), false)
  assert.equal(isChannelDown("upstream unavailable"), false)
  assert.equal(isModelUnserved("model_not_found"), true)
  assert.equal(isModelUnserved("无权访问该模型"), true)
  assert.equal(isMoneyRefusal("invalid schema"), false)
})
