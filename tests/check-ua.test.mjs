// tests/check-ua.test.mjs —— 出站 User-Agent 规定的语义锁
//
// 全部离线：只往临时目录写几个假插件文件，再跑 scanUserAgents。
// 这些断言对应的是「写错了不报错、只是上游回 403 说是网络繁忙」的那一类。

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CHROME_UA, OFFICIAL_UA_ALLOWLIST, scanUserAgents } from "../scripts/check-ua.mjs"

/** 造一个临时插件目录，files 是 {相对路径: 内容}。 */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "check-ua-"))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, body, "utf8")
  }
  return dir
}

const failsOf = (dir) => scanUserAgents(dir).filter((r) => r.level === "fail")
const warnsOf = (dir) => scanUserAgents(dir).filter((r) => r.level === "warn")

test("自产品名形态的 UA 判违规，并指出文件与行号", () => {
  const dir = fixture({
    "src/api.mjs": `const h = { "user-agent": "magpie-cnb-auth/0.1.0" }\n`,
  })
  const fails = failsOf(dir)
  assert.equal(fails.length, 1)
  assert.equal(fails[0].file, "src/api.mjs")
  assert.equal(fails[0].line, 1)
  assert.match(fails[0].message, /第三方客户端/)
  rmSync(dir, { recursive: true, force: true })
})

test("magpie-plugin/0.0.0 这种模板占位值也算违规", () => {
  const dir = fixture({
    "src/api.mjs": `export function headersFor() {\n  return { "user-agent": "magpie-plugin/0.0.0" }\n}\n`,
  })
  assert.equal(failsOf(dir).length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test("模板字面量里的版本号同样拦得住", () => {
  const dir = fixture({
    "src/context.mjs": "export const USER_AGENT = `magpie-opc-auth/${PLUGIN_VERSION}`\n",
  })
  assert.equal(failsOf(dir).length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test("运行时默认 UA（node / 非官方 Bun 版本）判违规", () => {
  const dir = fixture({
    "src/a.mjs": `const h = { "user-agent": "node" }\n`,
    "src/b.mjs": `h.set("user-agent", "Bun/1.4.4")\n`,
  })
  assert.equal(failsOf(dir).length, 2)
  rmSync(dir, { recursive: true, force: true })
})

test("实测的官方 UA `Bun/1.3.14` 放行（官方客户端就是 Bun 二进制）", () => {
  assert.equal(OFFICIAL_UA_ALLOWLIST.has("Bun/1.3.14"), true)
  const dir = fixture({
    "src/http.mjs": `export const OFFICIAL_UA = "Bun/1.3.14"\nconst h = { "user-agent": OFFICIAL_UA }\n`,
    "src/api.mjs": `export const h = { "user-agent": "Bun/1.3.14" }\n`,
  })
  assert.deepEqual(failsOf(dir), [])
  rmSync(dir, { recursive: true, force: true })
})

test("截断的 Mozilla 残句判违规（缺 Chrome/…）", () => {
  const dir = fixture({
    "src/wps.mjs": `const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"\n`,
  })
  const fails = failsOf(dir)
  assert.equal(fails.length, 1)
  assert.match(fails[0].message, /截断/)
  rmSync(dir, { recursive: true, force: true })
})

test("完整 Chrome UA 与官方 App UA 都算合规", () => {
  const dir = fixture({
    "src/web.mjs": `const h = { "user-agent": ${JSON.stringify(CHROME_UA)} }\n`,
    "src/app.mjs": `const h = { "user-agent": "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0" }\n`,
    "src/electron.mjs": `const CLIENT_UA = "Loomy|Desktop|Electron|macOS"\n`,
    "src/okhttp.mjs": `const h = { "user-agent": "okhttp/4.12.0" }\n`,
    "src/ua.mjs": `export const UA = "Mozilla/5.0 (win32; x64) AppleWebKit/537.36 (KHTML, like Gecko) aipy-pro/2.1.1 Chrome/134.0.6998.179 Electron/34.3.3 Safari/537.36"\n`,
  })
  assert.deepEqual(failsOf(dir), [])
  rmSync(dir, { recursive: true, force: true })
})

test("跨行拼接的 UA 接回来再判，不算残句", () => {
  const dir = fixture({
    "src/ua.mjs": [
      'export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "',
      '  + "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"',
      "",
    ].join("\n"),
  })
  assert.deepEqual(failsOf(dir), [])
  rmSync(dir, { recursive: true, force: true })
})

test("注释里的示例不算违规", () => {
  const dir = fixture({
    "src/api.mjs": [
      "// 反例：不要写 magpie-x/0.1.0",
      "/* 旧值 magpie-plugin/0.0.0 已废除 */",
      `const h = { "user-agent": ${JSON.stringify(CHROME_UA)} }`,
      "",
    ].join("\n"),
  })
  assert.deepEqual(failsOf(dir), [])
  rmSync(dir, { recursive: true, force: true })
})

test("打非本机上游却没设 UA 只报警告", () => {
  const dir = fixture({
    "src/api.mjs": `export const call = () => fetch("https://api.vendor.example/v1/chat", { method: "POST" })\n`,
  })
  assert.deepEqual(failsOf(dir), [])
  assert.equal(warnsOf(dir).length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test("只打本机网关 / CDP 的文件不报警告", () => {
  const dir = fixture({
    "src/local.mjs": "export const m = () => fetch(`http://127.0.0.1:${port}/v1/models`)\n",
  })
  assert.deepEqual(warnsOf(dir), [])
  rmSync(dir, { recursive: true, force: true })
})

test("tests/ 与 scripts/ 里的坏 UA 是故意的，不扫", () => {
  const dir = fixture({
    "tests/upstream-ua.mjs": `const h = { "user-agent": "magpie-x/1.0.0" }\n`,
    "scripts/release.mjs": `"User-Agent: magpie-plugin-release"`,
  })
  assert.deepEqual(failsOf(dir), [])
  rmSync(dir, { recursive: true, force: true })
})

test("值写成常量引用时按「设了 UA」处理，不再报漏设", () => {
  const dir = fixture({
    "src/api.mjs": [
      `import { OFFICIAL_UA } from "./http.mjs"`,
      `export const call = () => fetch("https://api.vendor.example/v1", { headers: { "user-agent": OFFICIAL_UA } })`,
      "",
    ].join("\n"),
  })
  assert.deepEqual(warnsOf(dir), [])
  rmSync(dir, { recursive: true, force: true })
})
