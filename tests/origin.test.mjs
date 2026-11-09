// tests/origin.test.mjs —— 出站 URL / origin 闸门（离线）
//
// 为什么单独锁：插件会把**用户凭据**（Bearer / 设备签名头）发到 `input` 指向的地方。
// 只要有一条出口允许「凭据 + 任意主机」，一次拼装错误就把账号送出去了。静态门禁
// （scripts/check.mjs）只看形态，看不出「这个 URL 到底属于谁」。
//
// 判据（AGENTS 铁律：`*_ALLOW_*` 这类闸门必须能被测试直接断言）：
//   · protocol 必须 https
//   · origin 必须与 src/context.mjs 的 BASE **完全一致**（不做后缀/前缀近似）
//   · 不允许 userinfo（`user:pass@` 或 `trusted@evil`）
//   · 相对路径只许以单个 `/` 开头（`//host` 是协议相对的绝对 URL）

import test from "node:test"
import assert from "node:assert/strict"

import { BASE } from "../src/context.mjs"
import {
  TRUSTED_BASE,
  UntrustedUrlError,
  assertTrustedUrl,
  pathUrl,
  trustedOrigin,
  trustedUrlOf,
} from "../src/origin.mjs"

const ORIGIN = new URL(BASE).origin

/** 必须被拒绝的输入（覆盖 AGENTS 要求的六类：evil 子域 / userinfo / http / 无协议 / 畸形 + 相似域） */
const REJECT = [
  ["evil 子域", "https://evil.phanthy.com/api/phanthy_code/models"],
  ["可信主机的子域", "https://code.phanthy.com.evil.com/api"],
  ["userinfo 伪装可信主机", "https://code.phanthy.com@example.com/api"],
  ["可信主机带 userinfo", "https://alice:user@code.phanthy.com/api"],
  ["http 明文", "http://code.phanthy.com/api/oauth/usage"],
  ["无协议（裸主机）", "code.phanthy.com/api/oauth/usage"],
  ["协议相对 //host", "//evil.com/api/phanthy_code/models"],
  ["非默认端口", "https://code.phanthy.com:8443/api"],
  ["畸形 URL", "https://"],
  ["不是 URL", "not a url"],
  ["空串", ""],
  ["空值", null],
]

test("可信 base：origin 与 BASE 完全一致，常量与 context.mjs 同源", () => {
  assert.equal(TRUSTED_BASE, BASE)
  assert.equal(trustedOrigin(), ORIGIN)
  assert.equal(trustedOrigin().endsWith("/"), false, "origin 不带尾斜杠（比较必须逐字相等）")
})

test("合法绝对 URL：原样返回 URL 对象，protocol=https、origin 不变", () => {
  const url = assertTrustedUrl(`${BASE}/api/oauth/usage?limit=5`)
  assert.ok(url instanceof URL)
  assert.equal(url.protocol, "https:")
  assert.equal(url.origin, ORIGIN)
  assert.equal(url.href, `${BASE}/api/oauth/usage?limit=5`)
  // URL 对象同样接受（fetch 的真实入参形态之一）
  assert.equal(assertTrustedUrl(new URL(`${BASE}/api/phanthy_code/models`)).href, `${BASE}/api/phanthy_code/models`)
})

test("合法相对路径：按 BASE 解析，查询串保留，且永远落在可信 origin", () => {
  assert.equal(trustedUrlOf("/api/oauth/usage").href, `${BASE}/api/oauth/usage`)
  assert.equal(trustedUrlOf("/api/work/rewards?limit=5").href, `${BASE}/api/work/rewards?limit=5`)
  assert.equal(
    assertTrustedUrl(`${BASE}/api/phanthy_code/models/stats`).origin,
    pathUrl("/api/phanthy_code/models/stats").origin,
  )
})

for (const [name, input] of REJECT) {
  test(`拒绝：${name}`, () => {
    for (const call of [() => assertTrustedUrl(input), () => trustedUrlOf(input)]) {
      assert.throws(call, (error) => {
        assert.ok(error instanceof UntrustedUrlError, `期望 UntrustedUrlError，实际 ${error?.name}`)
        assert.equal(error.code, "untrusted_origin")
        return true
      })
    }
  })
}

test("拒绝：相对路径必须单个 / 开头（`api/x` 与反斜杠变体都不算相对路径）", () => {
  for (const bad of ["api/oauth/usage", "\\evil.com/api", "/\\evil.com/api", "/api\\..\\..\\x", "/api/\r\nx"]) {
    assert.throws(() => pathUrl(bad), (error) => error.code === "untrusted_origin", `应拒绝：${JSON.stringify(bad)}`)
  }
})

test("错误信息不回显 userinfo（凭据不许被写进日志）", () => {
  assert.throws(
    () => assertTrustedUrl("https://alice:s3cr3t@example.com/api"),
    (error) => {
      assert.equal(error.code, "untrusted_origin")
      assert.equal(String(error.message).includes("s3cr3t"), false, "错误文本里不能出现密码")
      return true
    },
  )
})

test("拒绝理由可区分（协议 / 凭据 / 主机 / 路径），便于排障", () => {
  const reasonOf = (input) => {
    try {
      assertTrustedUrl(input)
      return ""
    } catch (error) {
      return error.reason
    }
  }
  const exitReasonOf = (input) => {
    try {
      trustedUrlOf(input)
      return ""
    } catch (error) {
      return error.reason
    }
  }
  assert.equal(reasonOf("http://code.phanthy.com/api"), "protocol")
  assert.equal(reasonOf("https://alice:user@code.phanthy.com/api"), "userinfo")
  assert.equal(reasonOf("https://evil.phanthy.com/api"), "origin")
  assert.equal(reasonOf("https://"), "not-absolute")
  // 相对路径分支只在出口入口（trustedUrlOf）里走
  assert.equal(exitReasonOf("code.phanthy.com/api"), "path")
  assert.equal(exitReasonOf("//evil.com/api"), "protocol-relative")
})
