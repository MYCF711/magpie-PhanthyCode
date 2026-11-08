// tests/check-error-codes.test.mjs —— 错误码门禁自己的回归锁（审计 F15 / F17）
//
// 这个脚本的规则曾经「能跑绿但语义错」：
//   · R2 只认 `code: "…"`，于是 `return "quota_exhausted"` 整类逃逸（审计 F3 的成因）
//   · R1 的通过文案带 `literalCodes >= 0` 这个恒真条件
//   · R5 / R7 / R9 根本没实现，输出里只看得到 R1/R3
// 所以这里用一次性临时目录把每条规则的**反例**跑一遍。

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { scanErrorCodes } from "../scripts/check-error-codes.mjs"

const plants = []

/** 造一个最小插件目录：src/http.mjs（词表真源）+ 若干文件 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "pw-codes-"))
  plants.push(dir)
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(
    join(dir, "src", "http.mjs"),
    `export const CODES = Object.freeze({
  sessionExpired: "session_expired",
  invalidRequest: "invalid_request",
  modelNotFound: "model_not_found",
  upstreamTimeout: "upstream_timeout",
})
`,
  )
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

const bad = (rows, rule) => rows.filter((r) => r.rule === rule && !r.ok)

test.after(() => {
  for (const dir of plants) rmSync(dir, { recursive: true, force: true })
})

test("R2 抓得到 `return \"…\"` 形态的越界 code（F3 的原始形态）", () => {
  const dir = fixture({
    "src/api.mjs": `export function errorCodeFor(status) {
  if (status === 402) return "quota_exhausted"
  return "invalid_request"
}
`,
  })
  const hits = bad(scanErrorCodes(dir), "R2")
  assert.equal(hits.length, 1)
  assert.match(hits[0].message, /quota_exhausted/)
})

test("R2 抓得到 `code: \"…\"`（ApiError / errorResponse 上下文）", () => {
  const dir = fixture({
    "src/api.mjs": `export function makeError() {
  return new ApiError("boom", { status: 502, code: "custom_error" })
}
`,
  })
  const hits = bad(scanErrorCodes(dir), "R2")
  assert.equal(hits.length, 1)
  assert.match(hits[0].message, /custom_error/)
})

test("R2 不误伤独立 Error 子类自己的 code（宿主不读它）", () => {
  const dir = fixture({
    "src/catalog.mjs": `export class CatalogShapeError extends Error {
  constructor(message) {
    super(message)
    this.name = "CatalogShapeError"
    this.code = "catalog_shape_invalid"
  }
}
`,
  })
  assert.deepEqual(bad(scanErrorCodes(dir), "R2"), [])
})

test("R1：errorResponse 少一个参数时失败，且不再打印「均带 code」", () => {
  const dir = fixture({
    "src/http.mjs2": "// unused\n",
    "src/exit.mjs": `export function fail(message, status) {
  return errorResponse(message, status)
}
`,
  })
  const rows = scanErrorCodes(dir)
  assert.equal(bad(rows, "R1").length, 1)
  assert.equal(rows.filter((r) => r.rule === "R1" && r.ok).length, 0, "有失败时不能再报「均带 code」")
})

test("R5：401 透传但没有 kept 头 → 失败；写了 kept → 通过", () => {
  const missing = fixture({
    "src/loader.mjs": `export async function pass(res) {
  if (res.status === 401) return res
  return res
}
`,
  })
  assert.equal(bad(scanErrorCodes(missing), "R5").length, 1)

  const kept = fixture({
    "src/loader.mjs": `export async function pass(res) {
  if (res.status === 401) {
    const headers = new Headers(res.headers)
    headers.set("x-magpie-sign-in", "kept")
    return new Response("", { status: 401, headers })
  }
  return res
}
`,
  })
  assert.deepEqual(bad(scanErrorCodes(kept), "R5"), [])
})

test("R7：空泛 message 失败，有信息量的通过", () => {
  const vague = fixture({
    "src/err.mjs": `export const make = () => new ApiError("服务异常", { status: 502 })`,
  })
  assert.equal(bad(scanErrorCodes(vague), "R7").length, 1)

  const detailed = fixture({
    "src/err.mjs": `export const make = (upstream) => new ApiError("上游单轮已跑 310 秒仍未完成（硬限 300 秒）", { status: 504 })`,
  })
  assert.deepEqual(bad(scanErrorCodes(detailed), "R7"), [])
})

test("R9：词表里每个 code 都要在 tests/ 出现过", () => {
  const missing = fixture({
    "src/api.mjs": "export const ok = 1\n",
    "tests/one.test.mjs": `assert.equal(code, "session_expired")\n`,
  })
  const rows = bad(scanErrorCodes(missing), "R9")
  assert.equal(rows.length, 1)
  assert.match(rows[0].message, /invalid_request/)
  assert.match(rows[0].message, /model_not_found/)

  const complete = fixture({
    "src/api.mjs": "export const ok = 1\n",
    "tests/one.test.mjs": ["session_expired", "invalid_request", "model_not_found", "upstream_timeout"]
      .map((code) => `assert.equal(x, "${code}")`)
      .join("\n"),
  })
  assert.deepEqual(bad(scanErrorCodes(complete), "R9"), [])
})

test("每条规则都至少产出一行（规则覆盖可见，F15）", () => {
  const dir = fixture({ "src/api.mjs": "export const ok = 1\n" })
  const rules = new Set(scanErrorCodes(dir).map((r) => r.rule))
  for (const rule of ["R1", "R2", "R4", "R6", "R7", "R8"]) {
    // R1/R3 只在有对应形态时出现；其余规则必须显式报告「无命中」
    if (rule === "R1" || rule === "R3") continue
    assert.ok(rules.has(rule), `${rule} 没有出现在输出里`)
  }
})
