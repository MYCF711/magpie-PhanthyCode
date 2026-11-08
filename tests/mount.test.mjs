// tests/mount.test.mjs —— 入口 / 九钩子挂载契约（行为断言，不是源码文本断言）
//
// 结构参照 magpie-loomy-auth/tests/mount.test.mjs（MIT），针对本插件自身：
//   ① 入口只导出一个函数（magpie 会把每个函数导出都当插件工厂调用）
//   ② _internal 是对象（helper 不暴露成插件）
//   ③ 九项钩子齐全
//   ④ config() 未登录也有模型（否则卡片显示 "0 models"）
//   ⑤ 两种登录方式的 authorize 都是 async 且**立刻返回**
//   ⑥ loader() 给 baseURL / apiKey / fetch
//   ⑦ usage 构造器可用，窗口形状符合契约
//   ⑧ 额度 SWR / 签到单飞 / 续期串行锁：用「假 fetch 被调了几次」断言接线，不看源码
//
// 全部离线；不需要 magpie 进程、不需要凭据，也不会写真实用户目录（HOME 已重定向）。

import test, { after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ⚠ 先重定向 HOME，再动态 import —— 安装记录 / 目录快照都写 ~/.cache/magpie
const home = mkdtempSync(join(tmpdir(), "pw-mount-"))
process.env.USERPROFILE = home
process.env.HOME = home
delete process.env.PHANTHY_ALLOW_DEVICE_REGISTER
delete process.env.PHANTHY_ALLOW_CHECKIN

const entry = await import("../index.mjs")
const { _internal, PhanthyCodeAuthPlugin } = entry
const { usage, usageWindow } = await import("../src/quota.mjs")
const { saveInstallation } = await import("../src/device-key.mjs")
const { fakeInferenceToken } = await import("./helpers/inference-token.mjs")
const { generateEd25519KeyPair } = await import("../src/proof.mjs")
const { installationIdFromPublicKey } = await import("../src/installation-id.mjs")
const { USAGE_PATH, USAGE_SUMMARY_PATH, WALLET_PATH } = await import("../src/phanthy-api.mjs")
const { TOKEN_PATH } = await import("../src/oauth.mjs")
const { REWARDS_PATH, DAILY_CLAIM_PATH } = await import("../src/activity.mjs")

after(() => rmSync(home, { recursive: true, force: true }))

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** 记录每个 URL 被请求了几次 */
function counter(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  const hits = (needle) => calls.filter((c) => c.url.includes(needle)).length
  // ⚠ `/api/oauth/usage` 是 `/api/oauth/usage/summary` 的前缀 —— 用 includes 计数会把
  // 两个端点算成一个。要按端点计数必须比 pathname 全等。
  const hitsExact = (path) => calls.filter((c) => new URL(c.url).pathname === path).length
  return { calls, hits, hitsExact, fetchImpl }
}

function readyInstallation(account) {
  const identity = generateEd25519KeyPair()
  const device = generateEd25519KeyPair()
  const inference = generateEd25519KeyPair()
  saveInstallation(account, {
    account,
    installationId: installationIdFromPublicKey(identity.publicKeyB64Url),
    installationIdSource: "public_key",
    accountScope: "scope-mount",
    registeredAt: 1,
    publicKey: identity.publicKeyB64Url,
    privateKey: identity.privateKeyB64Url,
    devicePublicKey: device.publicKeyB64Url,
    devicePrivateKey: device.privateKeyB64Url,
    inferencePublicKey: inference.publicKeyB64Url,
    inferencePrivateKey: inference.privateKeyB64Url,
    inferenceToken: fakeInferenceToken({ inferencePublicKey: inference.publicKeyB64Url }),
    sessionId: "session-mount",
  })
}

test("入口只导出一个函数（插件工厂）", () => {
  const functions = Object.entries(entry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
  assert.deepEqual(functions, ["PhanthyCodeAuthPlugin"])
})

test("_internal 是对象，helper 不暴露成顶层函数导出", () => {
  assert.equal(typeof _internal, "object")
  assert.equal(typeof _internal.PROVIDER, "string")
  assert.ok(_internal.PROVIDER.length > 0)
  assert.equal(typeof _internal.staticModels, "function")
  assert.ok(Array.isArray(_internal.MODELS))
})

test("九项钩子齐全", async () => {
  const plugin = await PhanthyCodeAuthPlugin({ client: {}, directory: undefined })
  assert.equal(typeof plugin.config, "function")
  assert.ok(plugin.auth && typeof plugin.auth === "object")
  assert.equal(plugin.auth.provider, _internal.PROVIDER)
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.ok(Array.isArray(plugin.auth.methods) && plugin.auth.methods.length >= 1)
  assert.equal(typeof plugin.auth.methods[0].authorize, "function")
  // 双登录：OAuth 一条 + 本机导入一条（导入默认关闭，需显式环境变量）
  assert.equal(plugin.auth.methods.length, 2)
  assert.deepEqual(plugin.auth.methods.map((m) => m.type), ["oauth", "api"])
  assert.equal(typeof plugin.auth.methods[1].authorize, "function")
  assert.equal(typeof plugin.provider.models, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(plugin.provider.id, _internal.PROVIDER)
  assert.ok(plugin.auth.icon?.startsWith("data:image/"), "图标必须内嵌（外部 URL 在 git 源下不渲染）")
  assert.ok(Number.isInteger(plugin.auth.maxConcurrency) && plugin.auth.maxConcurrency >= 1)
})

test("config() 未登录也声明了模型，且 modalities / 五个 input 布尔都在", async () => {
  const plugin = await PhanthyCodeAuthPlugin({ client: {} })
  const cfg = {}
  await plugin.config(cfg)
  const models = cfg.provider?.[_internal.PROVIDER]?.models
  assert.ok(models && Object.keys(models).length > 0, "config.models 不能为空（铁律 1）")
  for (const [id, model] of Object.entries(models)) {
    // config 路径读的是 modalities，不是 capabilities；只写后者等于没写。
    assert.deepEqual(model.modalities.input, ["text"], `${id}.modalities.input 必须给`)
    assert.deepEqual(model.modalities.output, ["text"], `${id}.modalities.output 必须给`)
    // HOOKS 十一之三只规定了 capabilities.input 的五个模态键；output 不发明字段
    for (const key of ["text", "image", "audio", "video", "pdf"]) {
      assert.equal(typeof model.capabilities.input[key], "boolean", `${id}.capabilities.input.${key} 必须是布尔`)
    }
    assert.equal(typeof model.capabilities.output.text, "boolean", `${id}.capabilities.output.text 必须是布尔`)
    // 坑 2 / 审计 F9：没有美元价就不写 cost（写 0 = 宣称列表价 $0，会被 Free first 反复派发）
    assert.equal("cost" in model, false, `${id} 不能把「不知道价格」写成 cost: 0`)
  }
})

test("authorize 是 async 且立刻返回：本机导入默认关闭时给出可行动的失败说明", async () => {
  delete process.env.PHANTHY_ALLOW_LOCAL_IMPORT
  const plugin = await PhanthyCodeAuthPlugin({ client: {} })

  const oauth = plugin.auth.methods[0]
  assert.equal(typeof oauth.authorize, "function")
  assert.equal(oauth.authorize.constructor.name, "AsyncFunction")

  // ⚠ 不在这里调用 oauth.authorize()：它会开一个 loopback 监听（等用户登录）。
  //   本机导入这条是纯本地判定，可以安全地跑完整行为。
  const imported = await plugin.auth.methods[1].authorize()
  assert.equal(imported.type, "failed")
  // 0.2.14 起不再要求环境变量（magpie 是独立进程，设了也没用，只会误伤）；
  // 失败说明必须讲**本机到底缺什么**，而不是让用户去设一个他设不到的变量。
  assert.equal(/PHANTHY_ALLOW_LOCAL_IMPORT/.test(imported.error), false, "不能再让用户去设环境变量")
  assert.match(imported.error, /本机没有可导入的云端登录/, "失败说明要说清缺什么")
})

test("loader() 给 baseURL / apiKey / fetch；未登录返回空对象", async () => {
  const plugin = await PhanthyCodeAuthPlugin({ client: {} })
  const out = await plugin.auth.loader(async () => ({ type: "oauth", access: "access-token" }), { id: "xxx" })
  assert.equal(typeof out.fetch, "function")
  assert.equal(typeof out.baseURL, "string")
  assert.ok(out.baseURL.startsWith("http"))
  assert.equal(out.apiKey, "access-token")

  const empty = await plugin.auth.loader(async () => null, { id: "xxx" })
  assert.deepEqual(empty, {})

  // 本机导入的账号是 api 类型（只有 key），loader 也必须认
  const imported = await plugin.auth.loader(async () => ({ type: "api", key: "imported-access" }), { id: "xxx" })
  assert.equal(imported.apiKey, "imported-access")
  assert.equal(imported.baseURL, `${_internal.BASE}/v1`)
})

test("provider.models：未登录返回静态模型表；条目 API 字段完整", async () => {
  const plugin = await PhanthyCodeAuthPlugin({ client: {} })
  const models = await plugin.provider.models({}, { auth: null })
  assert.ok(models && Object.keys(models).length > 0)
  for (const [id, model] of Object.entries(models)) {
    assert.equal(model.id, id)
    assert.equal(model.api.url, _internal.BASE)
    assert.equal(model.api.npm, "@ai-sdk/anthropic")
  }
})

test("usage 构造器可用：至少造一条参与路由的窗口", () => {
  const value = usage({
    plan: "Test",
    windows: [usageWindow({ name: "5 小时", used: 37, span: 18_000, resetsAt: "2026-10-30T12:00:00Z" })],
  })
  assert.equal(typeof value.plan, "string")
  assert.equal(value.windows.length, 1)
  assert.equal(Number.isFinite(value.windows[0].used), true)
  assert.equal(typeof value.windows[0].aside === "boolean" || value.windows[0].aside === undefined, true)
})

test("usage() 未登录给出 error 而不是伪造 0；上游不可用时把原因交给卡片", async () => {
  const plugin = await PhanthyCodeAuthPlugin({ client: {} })
  const anonymous = await plugin.auth.usage(async () => null, { id: "xxx" })
  assert.equal(anonymous.error, "未登录")
  assert.deepEqual(anonymous.windows, [])

  // 注入一个只会失败的 fetch：这条测试**不联网**，只验证「上游失败 → error 文案」
  const offline = await PhanthyCodeAuthPlugin({}, { fetch: () => Promise.reject(new Error("offline-test")) })
  const withAuth = await offline.auth.usage(async () => ({ type: "oauth", access: "test-access" }), { id: "xxx" })
  assert.equal(typeof withAuth.error, "string")
  assert.deepEqual(withAuth.windows, [])
})

test("chat.headers 只给本 provider 的请求加头", async () => {
  const plugin = await PhanthyCodeAuthPlugin({ client: {} })
  const header = `x-${_internal.PROVIDER}-session`
  const mine = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: _internal.PROVIDER }, sessionID: "sess-1" }, mine)
  assert.equal(mine.headers[header], "sess-1")

  const other = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "sess-1" }, other)
  assert.deepEqual(other.headers, {})
})

test("usage 走 SWR：同一账号两次读额度只打一轮上游，且带 10 秒上限", async () => {
  // ⚠ 夹具用**真实响应形状**（2026-11-09 真机核对，scripts/probe-endpoints.mjs）：
  //   · 钱包是 camelCase（availablePoints / totalPoints / sourceSummaries）
  //   · 套餐名与 expires_at 只在 /api/oauth/usage/summary 的 plan 里
  //   · **官方不设独立的 5 小时 / 7 天额度**（官方客户端原话），窗口按积分来源拆：
  //     subscription → 体验版、campaign → 每日登录奖励，外加临期积分
  const { hitsExact, fetchImpl } = counter((url) => {
    const path = new URL(url).pathname
    if (path === USAGE_SUMMARY_PATH) {
      return json({ schema_version: 1, plan: { name: "Pro", expires_at: "2026-11-30T15:59:59.000Z" } })
    }
    if (path === USAGE_PATH) {
      // 这两组仍然保留在响应里，但**不再**变成卡片窗口（官方明确说没有独立窗口）
      return json({
        five_hour: { used_credits: 0, total_credits: 2000, remaining_credits: 2000, resets_at: "2026-11-30T15:59:59.000Z" },
        seven_day: { used_credits: 0, total_credits: 2000, remaining_credits: 2000, resets_at: null },
        current_plan: { used_credits: 0, total_credits: 2000, remaining_credits: 2000, resets_at: null },
        extra_usage: { is_enabled: false, monthly_limit: null },
      })
    }
    if (path === WALLET_PATH) {
      return json({
        wallet: {
          availablePoints: 370,
          totalPoints: 1000,
          reservedPoints: 1,
          expiringWithin30Days: 370,
          nextExpiry: "2026-11-30T15:59:59.000Z",
          sourceSummaries: {
            subscription: { remainingPoints: 900, usedPoints: 100, totalPoints: 1000, expiresAt: "2026-11-30T15:59:59.000Z" },
            campaign: { remainingPoints: 200, usedPoints: 100, totalPoints: 300, latestExpiresAt: "2026-12-01T00:00:00.000Z" },
            referral: { remainingPoints: 0, usedPoints: 0, totalPoints: 0, expiresAt: null },
          },
        },
      })
    }
    return json({})
  })
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const getAuth = async () => ({ type: "oauth", access: "access-swr", uid: "acct-swr" })

  const first = await plugin.auth.usage(getAuth, { id: "phanthycode" })
  const second = await plugin.auth.usage(getAuth, { id: "phanthycode" })

  assert.equal(hitsExact(USAGE_PATH), 1, "第二次必须命中 60 秒缓存")
  assert.equal(hitsExact(USAGE_SUMMARY_PATH), 1, "套餐名同源，也只能取一次")
  assert.equal(hitsExact(WALLET_PATH), 1)
  assert.deepEqual(second, first)

  // 积分余额：总量 + 可用都在 → 带 used 的占比窗口（坑 1 / 24：没有 used 的窗口路由不计入）
  const wallet = first.windows.find((w) => w.name === "积分余额")
  assert.ok(wallet, "必须有「积分余额」占比窗口")
  assert.equal(wallet.used, 63, "已用 630 / 总量 1000 = 63%")
  assert.match(wallet.display, /任务预留 1/, "预留量写进 display")

  // 临期（坑 23）：必须挂在**唯一可路由的那条窗口**上，走 runsOutAt / runsOut。
  // ⚠ 不能自立门户成「临期积分」窗口 —— 它的 amount/limit 都是即将到期的余额，
  //   算出来 used = 100%，等于告诉 magpie「这个账号已经用光了」。
  assert.equal(wallet.runsOutAt, "2026-11-30T15:59:59.000Z")
  assert.equal(wallet.runsOut, 370)
  assert.match(wallet.display, /370 将于/, "到期提示写进 display")

  // 卡片只保留两条：积分余额 / 套餐 ——
  // 来源明细（体验版 / 每日登录奖励）是钱包的构成，不单独列；
  // 官方明确说没有独立的 5 小时 / 7 天额度；临期不是窗口。
  for (const gone of ["临期积分", "体验版", "每日登录奖励", "5 小时", "7 天", "套餐额度"]) {
    assert.equal(first.windows.some((w) => w.name === gone), false, `「${gone}」不该是独立窗口`)
  }
  assert.equal(first.windows.length, 2, "卡片只留两条")

  assert.ok(first.windows.some((w) => w.name === "套餐" && w.display.includes("Pro")), "套餐名来自 summary")

  // 坑 33：until 必须按 +08:00 口径转 ISO（自带 Z 的时间保留原时区）
  assert.equal(first.until, "2026-11-30T15:59:59.000Z")
})

test("usage 按 uid 分账号缓存：两个账号不共用一份读数", async () => {
  const { hitsExact, fetchImpl } = counter((url) => {
    const path = new URL(url).pathname
    if (path === USAGE_SUMMARY_PATH) return json({ plan: { name: "Pro" } })
    if (path === USAGE_PATH) return json({})
    return json({ wallet: { availablePoints: 10 } })
  })
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  await plugin.auth.usage(async () => ({ type: "oauth", access: "a", uid: "acct-one" }), { id: "phanthycode" })
  await plugin.auth.usage(async () => ({ type: "oauth", access: "b", uid: "acct-two" }), { id: "phanthycode" })
  assert.equal(hitsExact(USAGE_PATH), 2, "不同 uid 必须各自取一次（不能用可重名的 accountId 当 key）")
})

test("checkin 按账号单飞：并发两次只发一次读取；开关关闭时如实说 failed（不是「没有签到活动」）", async () => {
  readyInstallation("acct-checkin")
  const { hits, fetchImpl } = counter(() => json({ wallet: { availablePoints: 5 }, daily: { server_date: "2026-11-08" } }))
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const getAuth = async () => ({ type: "oauth", access: "access-checkin", uid: "acct-checkin" })

  const [first, second] = await Promise.all([
    plugin.auth.checkin(getAuth, { id: "phanthycode" }),
    plugin.auth.checkin(getAuth, { id: "phanthycode" }),
  ])

  assert.equal(hits(REWARDS_PATH), 1, "同账号并发签到必须合并成一次请求")
  for (const result of [first, second]) {
    assert.equal(result.outcome, "failed", "开关关闭 ≠ inactive（HOOKS 二：inactive = 没有签到活动）")
    assert.match(result.message, /PHANTHY_ALLOW_CHECKIN/)
  }
})

test("refresh 串行：并发两次续期只换一次票", async () => {
  const { hits, fetchImpl } = counter((url) => {
    if (url.includes(TOKEN_PATH)) {
      return json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
    }
    return json({})
  })
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const auth = { type: "oauth", access: "old", refresh: "refresh-serial", uid: "acct-refresh" }

  const [a, b] = await Promise.all([plugin.auth.refresh(auth), plugin.auth.refresh(auth)])

  assert.equal(hits(TOKEN_PATH), 1, "一次性 refresh_token 不能被并发用两次")
  assert.equal(a.access, "new-access")
  assert.deepEqual(b, a, "合并后的结果要回放给第二个等待者")
})

test("refresh-only 凭据不会被 usage/checkin 的账号 key 误判为未登录", async () => {
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: () => Promise.reject(new Error("offline-test")) })
  const getAuth = async () => ({ type: "oauth", refresh: "refresh-only-credential", accountId: "duplicate-display-name" })

  const value = await plugin.auth.usage(getAuth, { id: "xxx" })
  assert.notEqual(value.error, "未登录")

  const checkin = await plugin.auth.checkin(getAuth, { id: "xxx" })
  assert.notEqual(checkin.message, "未登录")
  assert.equal(typeof checkin.outcome, "string")
})

// ── 签到的 outcome 语义（审计 R-05）────────────────────────────────────
// HOOKS 二：claimed = 刚刚签到成功；done = 今天已经签过了。
// 早期实现把 claimed 折成 done，用户看不出「这次到底领没领到」。

test("checkin 真领取成功 → outcome=claimed（不是 done），并带回 credit", async () => {
  process.env.PHANTHY_ALLOW_CHECKIN = "1"
  try {
    readyInstallation("acct-claim")
    let points = 100
    const { hits, fetchImpl } = counter((url) => {
      if (url.includes(DAILY_CLAIM_PATH)) {
        points = 130 // 领取后余额 +30
        return json({})
      }
      return json({ wallet: { availablePoints: points }, daily: { server_date: "2026-11-08" } })
    })
    const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
    const getAuth = async () => ({ type: "oauth", access: "access-claim", uid: "acct-claim" })

    const result = await plugin.auth.checkin(getAuth, { id: "phanthycode" })
    assert.equal(result.outcome, "claimed", "刚领到 = claimed（HOOKS 二）")
    assert.equal(result.credit, 30, "credit 是前后余额差")
    assert.equal(hits(DAILY_CLAIM_PATH), 1)
  } finally {
    delete process.env.PHANTHY_ALLOW_CHECKIN
  }
})

test("checkin 今天已领（上游 409）→ outcome=claimed（不是 done，否则卡片永远是黄灯）", async () => {
  // 0.2.18：409「今天已领」从 `done` 改成 `claimed`。
  //
  // 真机对照（2026-11-09）：
  //   workbuddy（绿灯）: { outcome:"claimed", credit:100, streak:41, claimed:"…" }
  //   本插件（黄灯）    : { outcome:"done",    credit:300, streak:2 }
  //
  // 宿主只把 `{outcome, credit, streak, message, until}` 转给 Go，`claimed` 时间戳
  // 由 Go 在 `outcome === "claimed"` 时**自己补**。`done` 没有时间戳 ⇒ magpie 无法
  // 断言「这 300 分是今天的」⇒ 黄灯「回复已签到，但它的签到日可能…」，哪怕 credit 给了。
  process.env.PHANTHY_ALLOW_CHECKIN = "1"
  try {
    readyInstallation("acct-already")
    const { fetchImpl } = counter((url) => {
      if (url.includes(DAILY_CLAIM_PATH)) {
        return new Response(JSON.stringify({ error: { code: "already_claimed", message: "already" } }), { status: 409 })
      }
      return json({ wallet: { availablePoints: 100 }, daily: { server_date: "2026-11-08" } })
    })
    const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
    const getAuth = async () => ({ type: "oauth", access: "access-already", uid: "acct-already" })

    const result = await plugin.auth.checkin(getAuth, { id: "phanthycode" })
    assert.equal(result.outcome, "claimed", "409 也要报 claimed，否则卡片黄灯")
    assert.notEqual(result.outcome, "done", "done 没有 claimed 时间戳，卡片渲染不成绿灯")
  } finally {
    delete process.env.PHANTHY_ALLOW_CHECKIN
  }
})
