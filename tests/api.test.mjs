import test from "node:test"
import assert from "node:assert/strict"

import { ApiError, asModelError, isAuthFailure } from "../src/api.mjs"

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
