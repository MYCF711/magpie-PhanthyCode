// tests/token-ttl.test.mjs —— 令牌寿命的来源：**服务端 `expires_in` 优先，回退值统一**
//
// 为什么值得锁：寿命写错不会报错，只会表现为「每 30 分钟就要重登一次」或
// 「令牌明明过期了还当有效用」（真机上 403 request_not_authorized 就是这么来的）。
//
// 2026-11-09 实测：`POST /oauth/token` 明确返回 `expires_in: 1800`（30 分钟），
// JWT 的 `exp - iat` 也是 30 分钟 —— 所以寿命**不是**我们定的。

import test from "node:test"
import assert from "node:assert/strict"

const { refreshAccessToken } = await import("../src/oauth-device.mjs")
const { DEFAULT_EXPIRES_IN } = await import("../src/oauth.mjs")

const NOW = 1_800_000_000_000
const TOKEN_URL = "https://example.test/oauth/token"
const CLIENT = "phanthy-code-cli"

function fetchReturning(body, status = 200) {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("DEFAULT_EXPIRES_IN 是 1800 秒（官方实测值）", () => {
  assert.equal(DEFAULT_EXPIRES_IN, 1800)
})

test("服务端给了 expires_in → 用它（不写死）", async () => {
  const out = await refreshAccessToken({
    refresh: "r",
    tokenUrl: TOKEN_URL,
    clientId: CLIENT,
    now: () => NOW,
    fetchImpl: fetchReturning({ access_token: "a", refresh_token: "r2", expires_in: 900 }),
  })
  assert.equal(out.expires, NOW + 900_000, "必须用服务端给的 900 秒")
})

test("服务端**没给** expires_in → 回退到 DEFAULT_EXPIRES_IN（不是 8 小时）", async () => {
  const out = await refreshAccessToken({
    refresh: "r",
    tokenUrl: TOKEN_URL,
    clientId: CLIENT,
    now: () => NOW,
    fetchImpl: fetchReturning({ access_token: "a", refresh_token: "r2" }),
  })
  assert.equal(
    out.expires,
    NOW + DEFAULT_EXPIRES_IN * 1000,
    `回退值必须与 oauth.mjs 同口径（${DEFAULT_EXPIRES_IN} 秒），不能是 28_800`,
  )
})

test("服务端给 0 / 负数 → 也回退（不产生「立刻过期」的令牌）", async () => {
  for (const bad of [0, -1, null, "abc"]) {
    const out = await refreshAccessToken({
      refresh: "r",
      tokenUrl: TOKEN_URL,
      clientId: CLIENT,
      now: () => NOW,
      fetchImpl: fetchReturning({ access_token: "a", refresh_token: "r2", expires_in: bad }),
    })
    assert.equal(out.expires, NOW + DEFAULT_EXPIRES_IN * 1000, `expires_in=${JSON.stringify(bad)} 应回退`)
  }
})

test("上游没轮换 refresh_token 时沿用旧的（否则下次刷新就掉线）", async () => {
  const out = await refreshAccessToken({
    refresh: "old-refresh",
    tokenUrl: TOKEN_URL,
    clientId: CLIENT,
    now: () => NOW,
    fetchImpl: fetchReturning({ access_token: "a", expires_in: 1800 }),
  })
  assert.equal(out.refresh, "old-refresh")
})
