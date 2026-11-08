// tests/verify-loader.test.mjs —— 生产 loader 单链脚本的边界（静态 + 离线，不联网）
//
// 这个脚本会真发一次推理，所以它的「只发一次、max_tokens=16、不打印凭据」必须是
// 代码写死的，不能靠执行时自觉。

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("../scripts/verify-loader.mjs", import.meta.url), "utf8")

test("推理上限写死：max_tokens = 16，且只发一次", () => {
  assert.match(source, /export const MAX_TOKENS = 16/)
  assert.match(source, /max_tokens: MAX_TOKENS/)
  // 只有一处 POST /messages
  const posts = source.split("\n").filter((line) => line.includes("/messages`"))
  assert.equal(posts.length, 1, "推理请求只应有一处")
})

test("非流式、单轮、单条消息（不做批量或并发）", () => {
  assert.match(source, /stream: false/)
  assert.match(source, /messages: \[\{ role: "user"/)
  assert.equal(source.includes("Promise.all"), false, "不允许并发推理")
})

test("不打印凭据：access 只经 redact 输出", () => {
  assert.match(source, /function redact\(value\)/)
  const lines = source.split("\n").filter((line) => /\bconsole\./.test(line))
  for (const line of lines) {
    // 只关心真正的凭据字段；`max_tokens` 这类参数名不算
    if (/access\b|accessToken|\bkey\b|privateKey|desktop_inference_token/i.test(line)) {
      assert.match(line, /redact\(|length|len=/, `打印行未脱敏：${line.trim()}`)
    }
  }
})

test("签到只读：脚本里没有领取开关或 claim 调用", () => {
  assert.equal(/daily-login\/claim/.test(source), false)
  assert.equal(/PHANTHY_ALLOW_CHECKIN\s*=\s*1/.test(source), false)
})

test("生产 loader 脚本不自己发起 OAuth", () => {
  // 0.2.14：本机导入不再需要环境变量开关（magpie 是独立进程，设了也没用）。
  assert.equal(/PHANTHY_ALLOW_LOCAL_IMPORT !== "1"/.test(source), false, "不该再拿环境变量当闸门")
  assert.equal(/startLoopback/.test(source), false, "生产 loader 脚本不做交互登录")
})
