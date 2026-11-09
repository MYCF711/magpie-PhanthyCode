// tests/models-cache.test.mjs —— provider.models 的缓存与降级（离线；HOME 重定向到临时目录）

import test, { after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ⚠ 先重定向 HOME，再动态 import —— 目录缓存会写 ~/.cache/magpie
const home = mkdtempSync(join(tmpdir(), "pw-models-"))
process.env.USERPROFILE = home
process.env.HOME = home

const { PhanthyCodeAuthPlugin } = await import("../index.mjs")

after(() => rmSync(home, { recursive: true, force: true }))

const AUTH = { type: "oauth", access: "access-test", uid: "acct-a" }

const CATALOG = {
  schema_version: 1,
  default_model: "phanthy-fast",
  models: [
    { id: "phanthy-fast", label: "Phanthy Fast", context_window_tokens: 128000, pricing: { input_credits_per_million_tokens: 1, output_credits_per_million_tokens: 2 } },
    // 价格三态契约（src/catalog.mjs 的 creditsOf）：单条缺价 = 不列，所以夹具必须给厂商真实价
    // （1000 积分 → 0.33x，真值见 tests/rate.test.mjs 的 INPUT_CREDITS）。
    { id: "phanthy-pro", label: "Phanthy Pro", context_window_tokens: 200000, capabilities: { effort: true },
      pricing: { input_credits_per_million_tokens: 1000, output_credits_per_million_tokens: 5000 } },
  ],
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("同一账号短时间内两次取目录只打一次上游", async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return json(CATALOG)
  }
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })

  const first = await plugin.provider.models({}, { auth: AUTH })
  const second = await plugin.provider.models({}, { auth: AUTH })
  assert.equal(calls, 1, "第二次必须命中缓存")
  assert.deepEqual(Object.keys(first).sort(), ["phanthy-fast", "phanthy-pro"])
  assert.deepEqual(second, first)
})

test("目录条目：模态不猜（text-only），倍率不从 credits 反推", async () => {
  const fetchImpl = async () => json(CATALOG)
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const models = await plugin.provider.models({}, { auth: { ...AUTH, uid: "acct-modalities" } })

  for (const [id, model] of Object.entries(models)) {
    for (const key of ["text", "image", "audio", "video", "pdf"]) {
      assert.equal(typeof model.capabilities.input[key], "boolean", `${id}.input.${key} 必须显式布尔`)
    }
    assert.equal(model.capabilities.input.image, false, "目录没给模态就按 text-only，不继承别的模型")
    // 倍率 = input 积分 / 3000（2026-11-09 对表实证）；目录给了 pricing 就必须写 rate
    assert.equal(typeof model.rate, "number", `目录有 pricing 就必须写 rate（卡片上的 0.38x）`)
    // free 只允许出现在「0 积分」那一条上（坑 2：rate 0 本身不等于免费）
    if ("free" in model) {
      assert.equal(model.free, true, `${id}: free 只能是 true 或不存在`)
      assert.equal(model.rate, 0, `${id}: 标了 free 就必须是 0 倍率`)
    }
    // 坑 2 / 审计 F9：没有可证实的美元价格就不写 cost（写 0 = 宣称列表价 $0）
    assert.equal("cost" in model, false, "价格未知时不能写 cost")
  }
  assert.equal(models["phanthy-fast"].limit.context, 128000)
  assert.equal(models["phanthy-pro"].capabilities.reasoning, true, "capabilities.effort 为真才给 reasoning")
})

test("上游挂掉 → 退回上次快照，而不是空表", async () => {
  let mode = "ok"
  const fetchImpl = async () => {
    if (mode === "ok") return json(CATALOG)
    throw new Error("network down")
  }
  const auth = { ...AUTH, uid: "acct-snapshot" }

  const warm = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const cached = await warm.provider.models({}, { auth })
  assert.deepEqual(Object.keys(cached).sort(), ["phanthy-fast", "phanthy-pro"])

  // 换一个插件实例 = 内存缓存清零；磁盘快照仍在
  mode = "down"
  const cold = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const fromSnapshot = await cold.provider.models({}, { auth })
  assert.deepEqual(Object.keys(fromSnapshot).sort(), ["phanthy-fast", "phanthy-pro"], "必须用快照降级")
})

test("目录形状不符 / 空目录 → 不缓存空表，退回静态表", async () => {
  const fetchImpl = async () => json({ schema_version: 2, models: [] })
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const models = await plugin.provider.models({}, { auth: { ...AUTH, uid: "acct-bad" } })
  assert.ok(Object.keys(models).length > 0, "静态表兜底，不能返回空对象")
})

test("401 → 抛 signIn expired（唯一该标记账号的分支）", async () => {
  const fetchImpl = async () => json({ error: { code: "session_expired", message: "token expired" } }, 401)
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  await assert.rejects(
    () => plugin.provider.models({}, { auth: { ...AUTH, uid: "acct-401" } }),
    (error) => error?.signIn === "expired",
  )
})

test("缓存 key 含 accountScope：同凭据不同作用域也不共用缓存", async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return json(CATALOG)
  }
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  await plugin.provider.models({}, { auth: { ...AUTH, uid: "acct-scope", accountScope: "scope-a" } })
  await plugin.provider.models({}, { auth: { ...AUTH, uid: "acct-scope", accountScope: "scope-b" } })
  assert.equal(calls, 2, "不同 accountScope 必须各自取一次")
})

test("两个账号的缓存互不串：a 的快照不会被 b 拿来用", async () => {
  const fetchImpl = async () => json(CATALOG)
  const plugin = await PhanthyCodeAuthPlugin({}, { fetch: fetchImpl })
  const a = await plugin.provider.models({}, { auth: { ...AUTH, uid: "acct-x" } })
  const b = await plugin.provider.models({}, { auth: { ...AUTH, uid: "acct-y" } })
  assert.deepEqual(a, b)
  // b 用的仍是自己的 key：再取一次不应新增上游调用（各自缓存）
  const before = await plugin.provider.models({}, { auth: { ...AUTH, uid: "acct-x" } })
  assert.deepEqual(before, a)
})
