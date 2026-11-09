// tests/phanthy-api.test.mjs —— 云端请求外壳与错误映射（离线，注入 fetch）

import test, { after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ApiError, errorCodeFor, isQuotaRefusal } from "../src/api.mjs"
import { CatalogShapeError } from "../src/catalog.mjs"
import { BASE } from "../src/context.mjs"
import { PROFILE_PATH, fetchCatalog, fetchProfile, fetchUsage, request } from "../src/phanthy-api.mjs"
import { OFFICIAL_UA } from "../src/http.mjs"
import { sign as signBytes } from "node:crypto"
import { generateEd25519KeyPair, importPublicKey, v1Canonical, verifyCanonical } from "../src/proof.mjs"

// 安装记录 / 密钥缓存要落到临时 HOME，绝不碰真实用户目录。
const home = mkdtempSync(join(tmpdir(), "pw-phanthy-api-"))
process.env.USERPROFILE = home
process.env.HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

const AUTH = { type: "oauth", access: "access-test" }

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function recorder(response) {
  const calls = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return typeof response === "function" ? response(url, init) : response
    },
  }
}

test("GET：Bearer + 官方客户端 UA + 超时；不把 magpie 的 UA 透传上去", async () => {
  const { calls, fetchImpl } = recorder(jsonResponse({ ok: true }))
  const body = await request({ path: "/api/oauth/usage", auth: AUTH, fetchImpl })

  assert.deepEqual(body, { ok: true })
  assert.equal(calls[0].url, `${BASE}/api/oauth/usage`)
  assert.equal(calls[0].init.method, "GET")
  assert.equal(calls[0].init.headers.authorization, "Bearer access-test")
  // 官方客户端 UA（2026-11-09 抓包：Bun 编译的二进制，UA 就是运行时默认值），
  // 不是浏览器、更不是 magpie/x
  assert.equal(calls[0].init.headers["user-agent"], "Bun/1.3.14")
  assert.equal(calls[0].init.headers["user-agent"], OFFICIAL_UA)
  assert.equal(calls[0].init.headers["x-phanthy-client-source"], "desktop")
  assert.ok(!String(calls[0].init.headers["user-agent"]).startsWith("magpie"))
  assert.ok(calls[0].init.signal, "每个请求都必须带超时 signal")
  // L-5：跨站 302 会剥掉 authorization，但**会转发** x-desktop-* 签名头
  assert.equal(calls[0].init.redirect, "manual", "数据面不得自动跟随跨站重定向")
})

test("402 → quota_exhausted，且不算登录失效", async () => {
  const { fetchImpl } = recorder(jsonResponse({ error: { code: "insufficient_credits", message: "额度不足" } }, 402))
  await assert.rejects(
    () => request({ path: "/api/oauth/usage", auth: AUTH, fetchImpl }),
    (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 402)
      assert.equal(error.code, "quota_exhausted")
      assert.equal(isQuotaRefusal(error), true)
      assert.match(error.message, /额度不足/, "保留上游原文")
      return true
    },
  )
})

test("403 带套餐文案 → plan_required；403 普通权限 → upstream_error（§3 默认桶，不是 400 的 invalid_request）", async () => {
  const plan = recorder(jsonResponse({ error: { code: "missing_or_expired_plan", message: "no active plan" } }, 403))
  await assert.rejects(
    () => request({ path: "/api/oauth/usage", auth: AUTH, fetchImpl: plan.fetchImpl }),
    (error) => error instanceof ApiError && error.code === "plan_required" && error.status === 403,
  )

  const other = recorder(jsonResponse({ error: { code: "forbidden", message: "bot check" } }, 403))
  await assert.rejects(
    () => request({ path: "/api/oauth/usage", auth: AUTH, fetchImpl: other.fetchImpl }),
    (error) =>
      error instanceof ApiError &&
      error.code === "upstream_error" &&
      // status 原样透传，不改写成 400（§2：403 不杀账号）
      error.status === 403,
  )
})

test("状态码 → 词表 code 的映射表（覆盖 ERROR-CODES §3 的每一类出口）", () => {
  assert.equal(errorCodeFor(400, {}), "invalid_request")
  assert.equal(errorCodeFor(400, { error: { message: "content audit failed" } }), "audit_blocked")
  assert.equal(errorCodeFor(401, {}), "session_expired")
  assert.equal(errorCodeFor(402, {}), "quota_exhausted")
  assert.equal(errorCodeFor(403, {}), "upstream_error")
  assert.equal(errorCodeFor(403, { error: { message: "no active plan" } }), "plan_required")
  assert.equal(errorCodeFor(404, {}), "model_not_found")
  assert.equal(errorCodeFor(409, {}), "concurrency_conflict")
  assert.equal(errorCodeFor(429, {}), "rate_limited")
  assert.equal(errorCodeFor(500, {}), "upstream_unavailable")
  assert.equal(errorCodeFor(501, {}), "not_implemented")
  assert.equal(errorCodeFor(502, {}), "upstream_unavailable")
  assert.equal(errorCodeFor(504, {}), "upstream_timeout")
})

test("手动重定向：3xx 映射为 502 upstream_unavailable，不把 Location 当新请求目标", async () => {
  const { calls, fetchImpl } = recorder(jsonResponse({ error: { message: "redirect blocked" } }, 302))
  await assert.rejects(
    () => request({ path: "/api/oauth/usage", auth: AUTH, fetchImpl }),
    (error) => error instanceof ApiError && error.status === 502 && error.code === "upstream_unavailable",
  )
  assert.equal(calls.length, 1, "3xx 只能看到原请求，不能再发一次")
})

test("手动重定向：HTML 页面也在 JSON 解析前归一化为 502，且带词表 code", async () => {
  const { calls, fetchImpl } = recorder(new Response("<html><body>Moved</body></html>", {
    status: 302,
    headers: { "content-type": "text/html", location: "https://example.com/moved" },
  }))
  await assert.rejects(
    () => request({ path: "/api/oauth/usage", auth: AUTH, fetchImpl }),
    (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 502)
      assert.equal(error.code, "upstream_unavailable")
      assert.match(error.message, /HTTP 302/)
      return true
    },
  )
  assert.equal(calls.length, 1)
})

test("带签名头的请求：签的是最终 body 串，签名可用公钥验过", async () => {
  const pair = generateEd25519KeyPair()
  const { calls, fetchImpl } = recorder(jsonResponse({ ok: true }))
  const body = { inference_public_key: "PUBKEY_TEST" }

  await request({
    path: "/api/oauth/activities/summary",
    method: "POST",
    auth: AUTH,
    body,
    fetchImpl,
    sign: {
      installationId: "inst_0001",
      idempotencyKey: "activity:inst_0001:1767225600000",
      timestamp: "1767225600000",
      nonce: "NONCE_TEST_0001",
      sign: (canonical) => {
        // 复算：签名覆盖的必须是**发出去的那串**
        assert.equal(canonical, v1Canonical({
          method: "POST",
          upstreamPath: "/api/oauth/activities/summary",
          timestamp: "1767225600000",
          nonce: "NONCE_TEST_0001",
          body: JSON.stringify(body),
          idempotencyKey: "activity:inst_0001:1767225600000",
        }))
        return signBytes(null, Buffer.from(canonical, "utf8"), pair.privateKey).toString("base64url")
      },
    },
  })

  const headers = calls[0].init.headers
  assert.equal(calls[0].init.body, JSON.stringify(body), "签过的就是发出去的字节")
  assert.equal(calls[0].init.redirect, "manual", "带签名的请求不得自动跟随 3xx")
  assert.equal(headers["x-desktop-installation-id"], "inst_0001")
  assert.equal(headers["idempotency-key"], "activity:inst_0001:1767225600000")
  assert.ok(verifyCanonical(importPublicKey(pair.publicKeyB64Url), v1Canonical({
    method: "POST",
    upstreamPath: "/api/oauth/activities/summary",
    timestamp: "1767225600000",
    nonce: "NONCE_TEST_0001",
    body: JSON.stringify(body),
    idempotencyKey: "activity:inst_0001:1767225600000",
  }), headers["x-desktop-signature"]))
})

test("fetchCatalog：schema_version 不对 → CatalogShapeError（不是空列表）", async () => {
  const { fetchImpl } = recorder(jsonResponse({ schema_version: 3, models: [] }))
  await assert.rejects(() => fetchCatalog(AUTH, { fetchImpl }), CatalogShapeError)
})

test("fetchProfile：打 /api/oauth/profile，返回原始档案（accountScope 由调用方严格解析）", async () => {
  const { calls, fetchImpl } = recorder(jsonResponse({ account: { uuid: "8f14e45f-ceea-467a-9c1f-2b3d4e5f6a7b" } }))
  const body = await fetchProfile(AUTH, { fetchImpl })
  assert.equal(PROFILE_PATH, "/api/oauth/profile")
  assert.equal(calls[0].url, `${BASE}${PROFILE_PATH}`)
  assert.equal(body.account.uuid, "8f14e45f-ceea-467a-9c1f-2b3d4e5f6a7b")
})

test("fetchUsage：401 变成 session_expired（调用方据此标记账号）", async () => {
  const { fetchImpl } = recorder(jsonResponse({ error: { message: "token expired" } }, 401))
  await assert.rejects(
    () => fetchUsage(AUTH, { fetchImpl }),
    (error) => error instanceof ApiError && error.status === 401 && error.code === "session_expired",
  )
})

// ── 出口守卫（缺陷 B）：绝对 URL 必须是 BASE 的 https origin，否则一条请求都不发 ──

/** 与 tests/origin.test.mjs 同一矩阵：出口层再验一遍，防止「模块写对了但没接上」 */
const UNTRUSTED = [
  ["evil 子域", "https://evil.phanthy.com/api/oauth/usage"],
  ["相似域", "https://code.phanthy.com.evil.com/api/oauth/usage"],
  ["userinfo 伪装", "https://code.phanthy.com@example.com/api/oauth/usage"],
  ["可信主机带 userinfo", "https://alice:user@code.phanthy.com/api/oauth/usage"],
  ["http 明文", "http://code.phanthy.com/api/oauth/usage"],
  ["无协议", "code.phanthy.com/api/oauth/usage"],
  ["协议相对", "//evil.com/api/oauth/usage"],
  ["畸形 URL", "https://"],
]

for (const [name, path] of UNTRUSTED) {
  test(`出口守卫：${name} → untrusted_origin，且一条请求都不发`, async () => {
    const { calls, fetchImpl } = recorder(jsonResponse({ ok: true }))
    await assert.rejects(
      () => request({ path, auth: AUTH, fetchImpl }),
      (error) => {
        assert.equal(error.code, "untrusted_origin")
        return true
      },
    )
    assert.equal(calls.length, 0, "被拒绝的 URL 不能先发出去再报错")
  })
}

test("出口守卫：可信 origin 的绝对 URL 与相对路径都能发出（查询串原样保留）", async () => {
  const rel = recorder(jsonResponse({ ok: true }))
  await request({ path: "/api/phanthy_code/models/stats", auth: AUTH, fetchImpl: rel.fetchImpl })
  assert.equal(rel.calls[0].url, `${BASE}/api/phanthy_code/models/stats`)

  const abs = recorder(jsonResponse({ ok: true }))
  await request({ path: `${BASE}/api/work/rewards?limit=5`, auth: AUTH, fetchImpl: abs.fetchImpl })
  assert.equal(abs.calls[0].url, `${BASE}/api/work/rewards?limit=5`)
  assert.equal(abs.calls[0].init.headers.authorization, "Bearer access-test", "守卫不能把凭据丢掉")
})

// ── L-5：设备注册（真正的写入面）同样不许自动跟随 3xx ──────────────────

test("registerDevice：POST 注册带 redirect: manual —— 签名头不会跟着重定向走", async () => {
  const identity = generateEd25519KeyPair()
  const device = generateEd25519KeyPair()
  const record = {
    installationId: "di_redirect_0001",
    publicKey: identity.publicKeyB64Url,
    privateKey: identity.privateKeyB64Url,
    devicePublicKey: device.publicKeyB64Url,
    devicePrivateKey: device.privateKeyB64Url,
    accountScope: "scope-test",
  }
  const { calls, fetchImpl } = recorder(jsonResponse({ ok: true }))
  const { registerDevice } = await import("../src/phanthy-api.mjs")

  await registerDevice({
    auth: AUTH,
    record,
    policy: { bindingSigner: "device", headerSigner: "identity", deviceKeyDistinct: true },
    sessionKeyPublicKey: generateEd25519KeyPair().publicKeyB64Url,
    accountScope: "scope-test",
    fetchImpl,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${BASE}/api/oauth/desktop-installations/register`)
  assert.equal(calls[0].init.redirect, "manual", "注册写入面也不许自动跟随跨站 3xx")
})

// ── M-1 文案：缺 inference 公钥 ≠「重跑一次设备注册会补齐」 ────────────

test("M-1 文案：缺 inference 公钥时指向修复/迁移安装记录，而不是假承诺", async () => {
  const identity = generateEd25519KeyPair()
  const account = "legacy-upgrade-record"
  const { saveInstallation } = await import("../src/device-key.mjs")
  const { requestInferenceToken } = await import("../src/phanthy-api.mjs")
  // 0.2.3 升级现场：已注册（registeredAt 有值）+ accountScope 已写，但只有 identity 一对
  saveInstallation(account, {
    account,
    installationId: "di_legacy_0001",
    accountScope: "scope-legacy",
    registeredAt: 1,
    publicKey: identity.publicKeyB64Url,
    privateKey: identity.privateKeyB64Url,
    devicePublicKey: "",
    devicePrivateKey: "",
    inferencePublicKey: "",
    inferencePrivateKey: "",
  })

  await assert.rejects(
    () =>
      requestInferenceToken({
        account,
        auth: AUTH,
        fetchImpl: async () => {
          throw new Error("缺密钥时不该发请求")
        },
      }),
    (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 409)
      assert.equal(error.code, "not_implemented")
      assert.match(error.message, /修复|迁移/, "文案必须指向先修复/迁移安装记录")
      assert.doesNotMatch(error.message, /重新跑一次设备注册会补齐/, "重跑注册不会补齐（正是 M-1 的假承诺）")
      return true
    },
  )
})
