import test from "node:test"
import assert from "node:assert/strict"

import { ApiError, asModelError, get, isAuthFailure } from "../src/api.mjs"
import { BASE } from "../src/context.mjs"

test("asModelError 只改写明确的模型错误，不把任意 400/422 当 404", () => {
  const model = new ApiError("model is not available", { status: 400 })
  assert.equal(asModelError(model).status, 404)

  for (const status of [400, 422]) {
    const schema = new ApiError("tools.0.parameters is invalid", { status })
    assert.equal(asModelError(schema), schema)
    assert.equal(asModelError(schema).status, status)
  }
})

test("isAuthFailure 对 401 保持登录语义，但不再把所有 403 当失效", () => {
  assert.equal(isAuthFailure(new ApiError("session expired", { status: 401 })), true)
  assert.equal(isAuthFailure(new ApiError("not_logged_in", { status: 403 })), true)
  assert.equal(isAuthFailure(new ApiError("model permission denied", { status: 403 })), false)
  assert.equal(isAuthFailure(new ApiError("Cloudflare bot blocked", { status: 403 })), false)
  assert.equal(isAuthFailure(new ApiError("model unavailable", { status: 404 })), false)
})

// ── get() 的出口守卫：凭据只会发到 BASE 的 https origin ────────────────────

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function recorder() {
  const calls = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ ok: true })
    },
  }
}

const UNTRUSTED = [
  ["evil 子域", "https://evil.phanthy.com/api/oauth/usage"],
  ["相似域", "https://code.phanthy.com.evil.com/api"],
  ["userinfo 伪装", "https://code.phanthy.com@example.com/api"],
  ["userinfo", "https://alice:user@code.phanthy.com/api"],
  ["http 明文", "http://code.phanthy.com/api/oauth/usage"],
  ["无协议", "code.phanthy.com/api/oauth/usage"],
  ["协议相对", "//evil.com/api"],
  ["畸形 URL", "https://"],
]

for (const [name, path] of UNTRUSTED) {
  test(`get()：${name} → 拒绝且不发请求`, async () => {
    const { calls, fetchImpl } = recorder()
    await assert.rejects(
      () => get(path, { access: "access-test" }, { fetchImpl }),
      (error) => error.code === "untrusted_origin",
    )
    assert.equal(calls.length, 0)
  })
}

test("get()：相对路径按 BASE 解析；可信绝对 URL 原样发出并带 Bearer", async () => {
  const rel = recorder()
  await get("/api/oauth/usage", { access: "access-test" }, { fetchImpl: rel.fetchImpl })
  assert.equal(rel.calls[0].url, `${BASE}/api/oauth/usage`)
  assert.equal(rel.calls[0].init.headers.authorization, "Bearer access-test")
  // L-5：跨站 302 时 undici 会剥掉 authorization、但**会转发**签名头 —— 不许自动跟随
  assert.equal(rel.calls[0].init.redirect, "manual", "数据面不得自动跟随跨站重定向")

  const abs = recorder()
  await get(`${BASE}/api/work/rewards?limit=5`, { access: "access-test" }, { fetchImpl: abs.fetchImpl })
  assert.equal(abs.calls[0].url, `${BASE}/api/work/rewards?limit=5`)
  assert.equal(abs.calls[0].init.redirect, "manual")
})
