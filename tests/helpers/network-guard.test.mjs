// tests/helpers/network-guard.test.mjs —— 守卫自身的证明（离线）
//
// 守卫的价值在于「真的会拦」，所以它自己也必须被测：
//   · 外部 URL → 抛错，且计数 +1；
//   · 回环 URL → 放行（模板的 loopback 测试依赖它）；
//   · 未注入 fetch 的插件在测试环境下不能把请求打出去。

import test from "node:test"
import assert from "node:assert/strict"

const guard = await import("./network-guard.mjs")

test("外部地址被拦截，并计入 blocked", () => {
  const before = guard.blockedCount()
  assert.throws(
    () => globalThis.fetch("https://code.phanthy.com/api/phanthy_code/models"),
    /测试禁止真实网络|测试环境禁止外部出站/,
  )
  assert.equal(guard.blockedCount(), before + 1)
  // 自证完清零：整套跑完后若还打印“拦截了 N 次”，那就是真实出站
  guard.resetBlocked()
})

test("回环地址放行（不计数）", async () => {
  const before = guard.blockedCount()
  // 起一个本地最小服务，验证 127.0.0.1 不会被守卫拦
  const { createServer } = await import("node:http")
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end('{"ok":true}')
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  try {
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.equal(guard.blockedCount(), before, "回环不应计为出站")
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("插件在测试环境里不注入 fetch 也不会打到外部", async () => {
  const before = guard.blockedCount()
  const { PhanthyCodeAuthPlugin } = await import("../../index.mjs")
  const plugin = await PhanthyCodeAuthPlugin({}, {})
  // 插件自身防线会在请求那一刻抛错；models() 把它当作上游失败降级成静态表，
  // 关键断言是：**一次外部请求都没发出去**。
  const models = await plugin.provider.models({}, { auth: { type: "oauth", access: "fake", uid: "guard-test" } })
  assert.ok(Object.keys(models).length > 0, "降级成静态表，而不是空表")
  assert.equal(guard.blockedCount(), before, "插件路径上没有发生外部出站")
})
