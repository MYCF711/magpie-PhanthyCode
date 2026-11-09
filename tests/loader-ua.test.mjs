// tests/loader-ua.test.mjs —— loader 出站行为：UA / 非登录 401 / 超时分类（离线）
//
// 这四条都是「静态门禁查不出来、但运行期真的会把账号或请求打坏」的形态：
//   ① 宿主把 `user-agent: magpie/<ver>` 塞进 init.headers，插件重建头时漏掉它 →
//      上游收到的是宿主 UA（坑 38 的实证形态，审计 F1）。check-ua.mjs 只看字面量。
//   ② 上游对**单个模型**回 401 → 宿主停整个账号；必须带 `X-Magpie-Sign-In: kept`（R5）。
//   ③ 真·登录失效的 401 不能加 kept（否则账号永远不刷新、永远失败）。
//   ④ `AbortSignal.timeout` 抛裸 `TimeoutError` → 必须包成 504 upstream_timeout（R8）。

import test, { after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "pw-loader-ua-"))
process.env.USERPROFILE = home
process.env.HOME = home

const { PhanthyCodeAuthPlugin } = await import("../index.mjs")
const { OFFICIAL_UA } = await import("../src/http.mjs")
const { _resetInflight } = await import("../src/production-auth.mjs")
const { ensureInstallation, readInstallation, saveInstallation } = await import("../src/device-key.mjs")
const { generateEd25519KeyPair, importPublicKey, inferenceCanonical, verifyCanonical } = await import("../src/proof.mjs")
const { installationIdFromPublicKey } = await import("../src/installation-id.mjs")
const { fakeInferenceToken } = await import("./helpers/inference-token.mjs")

after(() => rmSync(home, { recursive: true, force: true }))
beforeEach(() => _resetInflight())

const AUTH = { type: "oauth", access: "access-test", uid: "acct-ua" }

/** 造一条「已就绪」的安装记录：loader 因此不会再走注册链（零请求） */
function readyInstallation(account) {
  const identity = generateEd25519KeyPair()
  const device = generateEd25519KeyPair()
  const inference = generateEd25519KeyPair()
  saveInstallation(account, {
    account,
    installationId: installationIdFromPublicKey(identity.publicKeyB64Url),
    installationIdSource: "public_key",
    accountScope: "scope-test",
    registeredAt: 1,
    registrationStatus: 200,
    publicKey: identity.publicKeyB64Url,
    privateKey: identity.privateKeyB64Url,
    devicePublicKey: device.publicKeyB64Url,
    devicePrivateKey: device.privateKeyB64Url,
    inferencePublicKey: inference.publicKeyB64Url,
    inferencePrivateKey: inference.privateKeyB64Url,
    inferenceToken: fakeInferenceToken({ inferencePublicKey: inference.publicKeyB64Url }),
    inferenceTokenAt: 1,
    sessionId: "session-test",
  })
}

/** 记录 fetch 收到的 init，返回给定响应 */
function recorder(response) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (typeof response === "function") return response(url, init)
    return response
  }
  return { calls, fetchImpl }
}

const okBody = JSON.stringify({ id: "msg_1", type: "message" })
const okResponse = () =>
  new Response(okBody, { status: 200, headers: { "content-type": "application/json" } })

async function loaderWith(fetchImpl, uid = "acct-ua") {
  readyInstallation(uid)
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  return plugin.auth.loader(async () => ({ ...AUTH, uid }), { id: "phanthycode" })
}

test("宿主注入的 user-agent 不会透传给上游：上游只看到官方客户端 UA", async () => {
  const { calls, fetchImpl } = recorder(okResponse())
  const loader = await loaderWith(fetchImpl)

  const res = await loader.fetch("https://code.phanthy.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "phanthy-fast", messages: [] }),
    headers: {
      // 宿主真实会塞的东西（坑 38 的现场）
      "user-agent": "magpie/0.1.2019",
      "x-request-id": "req-from-host",
      "x-claude-code-session-id": "sess-host",
    },
  })

  assert.equal(res.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.redirect, "manual", "带签名头的请求不得自动跟随跨站重定向")
  const sent = calls[0].init.headers
  assert.equal(sent["user-agent"], OFFICIAL_UA, "官方 UA 必须覆盖宿主的 magpie/<ver>")
  assert.ok(!String(sent["user-agent"]).startsWith("magpie"))
  // 其它宿主头照常透传（只有 hop-by-hop / authorization / x-api-key / user-agent 被丢掉）
  assert.equal(sent["x-request-id"], "req-from-host")
  assert.equal(sent["x-claude-code-session-id"], "sess-host")
  // 签名四头齐全
  for (const key of [
    "x-phanthy-desktop-session",
    "x-phanthy-proof-timestamp",
    "x-phanthy-proof-nonce",
    "x-phanthy-proof-signature",
  ]) {
    assert.ok(sent[key], `${key} 必须带上`)
  }
  // x-phanthy-desktop-session 放的是**推理令牌本身**（PROTOCOL-INFERENCE.md §三），不是 sessionId
  assert.equal(sent["x-phanthy-desktop-session"], readInstallation("acct-ua").inferenceToken)
})

test("x-phanthy-session 摊成会话三件套：session-id 覆盖、expert/skill 删掉", async () => {
  const { calls, fetchImpl } = recorder(okResponse())
  const loader = await loaderWith(fetchImpl, "acct-session")

  await loader.fetch("https://code.phanthy.com/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "phanthy-fast", messages: [] }),
    headers: {
      "x-phanthy-session": "sess-from-client",
      "x-phanthy-expert-id": "expert-should-be-dropped",
      "x-phanthy-skill-names": "a,b",
      "x-request-id": "req-1",
    },
  })

  const sent = calls[0].init.headers
  assert.equal(sent["x-claude-code-session-id"], "sess-from-client")
  assert.equal(sent["x-phanthy-expert-id"], undefined, "expert 由桥按会话元数据重填，插件拿不到就空")
  assert.equal(sent["x-phanthy-skill-names"], undefined)
})

test("12 段推理证明用 inference 私钥签：identity / device 都验不过", async () => {
  const account = "acct-proof-key"
  const { record } = ensureInstallation({ account })
  // ⚠ 令牌只能造一次并复用：fakeInferenceToken 里带 iat，重复调用会得到不同的串，
  //   而 canonical 第 8 段是 b64url(sha256(token)) —— 两次不一致就验不过。
  const token = fakeInferenceToken({ inferencePublicKey: record.inferencePublicKey })
  saveInstallation(account, {
    ...record,
    accountScope: "scope-proof",
    registeredAt: 1,
    inferenceToken: token,
  })

  const { calls, fetchImpl } = recorder(okResponse())
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const loader = await plugin.auth.loader(async () => ({ ...AUTH, uid: account }), { id: "phanthycode" })

  const body = JSON.stringify({ model: "phanthy-fast", messages: [{ role: "user", content: "hi" }] })
  await loader.fetch("https://code.phanthy.com/v1/messages", { method: "POST", body })

  const sent = calls[0].init.headers
  const canonical = inferenceCanonical({
    method: "POST",
    pathname: "/v1/messages",
    timestamp: sent["x-phanthy-proof-timestamp"],
    nonce: sent["x-phanthy-proof-nonce"],
    body,
    authorization: sent.authorization,
    inferenceToken: token,
    requestId: sent["x-request-id"],
  })

  assert.equal(verifyCanonical(importPublicKey(record.inferencePublicKey), canonical, sent["x-phanthy-proof-signature"]), true)
  assert.equal(
    verifyCanonical(importPublicKey(record.publicKey), canonical, sent["x-phanthy-proof-signature"]),
    false,
    "identity 私钥签不过 —— 这把钥匙是 inference 的",
  )
  assert.equal(verifyCanonical(importPublicKey(record.devicePublicKey), canonical, sent["x-phanthy-proof-signature"]), false)
})

test("上游对单个模型回 401 → 加 X-Magpie-Sign-In: kept，正文原样", async () => {
  const body = JSON.stringify({ error: { message: "model is not enabled for this account" } })
  const { fetchImpl } = recorder(() => new Response(body, { status: 401, headers: { "content-type": "application/json" } }))
  const loader = await loaderWith(fetchImpl)

  const res = await loader.fetch("https://code.phanthy.com/v1/messages", { method: "POST", body: "{}" })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(await res.text(), body, "错误正文必须原样交给宿主（R7）")
})

test("真·登录失效的 401 不加 kept —— 否则这个账号永远刷新不回来", async () => {
  const { fetchImpl } = recorder(
    () => new Response(JSON.stringify({ error: { message: "invalid access token" } }), { status: 401 }),
  )
  const loader = await loaderWith(fetchImpl)

  const res = await loader.fetch("https://code.phanthy.com/v1/messages", { method: "POST", body: "{}" })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get("x-magpie-sign-in"), null)
})

// L-7：withSignInHint 用 `res.clone().text()` 解出**明文**后重建 Response。
// 如果照抄上游的 content-encoding: gzip，下游会再解一次 gzip 而爆错；
// content-length 也已经是明文的长度，必须交给运行时重算。
test("withSignInHint 重建 Response：content-encoding / content-length 必须删掉，正文仍是明文", async () => {
  const body = JSON.stringify({ error: { message: "model is not enabled for this account" } })
  const { fetchImpl } = recorder(
    () =>
      new Response(body, {
        status: 401,
        headers: {
          "content-type": "application/json",
          // 上游（经网关）真会带这两个头
          "content-encoding": "gzip",
          "content-length": String(Buffer.byteLength(body)),
        },
      }),
  )
  const loader = await loaderWith(fetchImpl, "acct-sign-in-hint-headers")

  const res = await loader.fetch("https://code.phanthy.com/v1/messages", { method: "POST", body: "{}" })

  assert.equal(res.status, 401)
  assert.equal(res.headers.get("x-magpie-sign-in"), "kept")
  assert.equal(res.headers.get("content-encoding"), null, "重建后的正文是明文，不能带 gzip 头")
  assert.equal(res.headers.get("content-length"), null, "长度已变，必须交给运行时重算")
  assert.equal(await res.text(), body, "正文必须原样可读（R7）")
})

test("超时 → 504 upstream_timeout，而不是把裸 TimeoutError 扔进聊天通道", async () => {
  const { fetchImpl } = recorder(() => {
    const error = new Error("The operation was aborted due to timeout")
    error.name = "TimeoutError"
    throw error
  })
  const loader = await loaderWith(fetchImpl, "acct-timeout")

  await assert.rejects(
    () => loader.fetch("https://code.phanthy.com/v1/messages", { method: "POST", body: "{}" }),
    (error) => {
      assert.equal(error.status, 504, "超时落 504（R8），不能 502/404")
      assert.equal(error.code, "upstream_timeout")
      assert.match(error.message, /超时|timeout/i)
      return true
    },
  )
})

test("宿主主动取消（signal 已 abort）不算超时：原样抛出，不伪装成 504", async () => {
  const { fetchImpl } = recorder(() => {
    const error = new Error("The operation was aborted")
    error.name = "AbortError"
    throw error
  })
  const loader = await loaderWith(fetchImpl, "acct-abort")
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    () =>
      loader.fetch("https://code.phanthy.com/v1/messages", {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      }),
    (error) => {
      assert.equal(error.name, "AbortError")
      assert.equal(error.status, undefined)
      return true
    },
  )
})
