// tests/probe-checkin-live.test.mjs —— scripts/probe-checkin-live.mjs 的静态 + 单元测试
//
// 两条硬约束：
//   ① **绝不读真实 `~/.config/magpie/plugin-auth.json`，也绝不调用真实 checkin**：
//      登录态用临时 HOME + 假数据注入，插件用假工厂注入；整套测试在 network-guard 下跑。
//   ② 旧版脚本**没有导出任何纯函数**、且 import 就会读真实登录态并真的领取 ——
//      所以动态用例先静态确认「已导出」，不满足就直接失败，绝不去 import 旧版。

import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = new URL("../scripts/probe-checkin-live.mjs", import.meta.url)

/** 脚本源码（静态断言用；不执行、不 import） */
function sourceText() {
  return readFileSync(SCRIPT, "utf8")
}

/**
 * 安全加载被测脚本。
 *
 * 旧版没有 `export function ...`，import 它会直接执行：读真实登录态、发起真实领取。
 * 因此这里先断「已导出纯函数」，不满足就红，绝不 import。
 */
async function load() {
  assert.match(
    sourceText(),
    /export function parseArgs/,
    "脚本必须导出纯函数（旧版没有导出，import 就会真的领取）",
  )
  return import(SCRIPT.href)
}

/** 假 auth 节点：形状照抄 magpie 的 oauth 登录态（值全是假的） */
const AUTH_NODE = {
  type: "oauth",
  access: "access-value",
  key: "key-value",
  refresh: "refresh-value",
  expires: 1_800_000_000_000,
  accountId: "示例账号",
  email: "user@example.com",
  uid: "uid-value",
  accountScope: "scope-value",
  metadata: { email: "user@example.com", kind: "oauth" },
}

/** 临时 HOME（带 .config/magpie 目录），用完删掉 */
function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), "probe-checkin-"))
  mkdirSync(join(home, ".config", "magpie"), { recursive: true })
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

function writeStore(home, store) {
  writeFileSync(join(home, ".config", "magpie", "plugin-auth.json"), JSON.stringify(store))
}

function writeRawStore(home, text) {
  writeFileSync(join(home, ".config", "magpie", "plugin-auth.json"), text)
}

function capture() {
  const lines = []
  return {
    lines,
    write: (line) => lines.push(String(line)),
    text: () => lines.join("\n"),
  }
}

// ───────────────────────────── 静态面（旧版也应最多只在这里失败）─────────────────────────────

test("脚本只读 .phanthycode，不静默回退到别的 provider", () => {
  const text = sourceText()
  assert.match(text, /phanthycode/, "必须读取 phanthycode 节点")
  assert.doesNotMatch(
    text,
    /\.phanthy(?!code)/,
    "不得出现 .phanthy 回退（旧版错读的正是 .phanthy）",
  )
})

test("真实领取必须由显式 --yes 开启", () => {
  const text = sourceText()
  assert.match(text, /--yes/, "必须接受 --yes 参数")
  assert.match(text, /args\.yes|options\.yes/, "必须按解析出来的 yes 分支决定是否执行")
})

test("脚本顶层不做 IO / 网络，执行入口放文件末尾", () => {
  const text = sourceText()
  assert.doesNotMatch(
    text,
    /^\s*(const|let|var)\s+\w+\s*=\s*JSON\.parse\(readFileSync/m,
    "不得在顶层读登录态",
  )
  assert.match(text, /import\.meta\.url/, "直接执行判定应基于 import.meta.url")
})

// ───────────────────────────── 纯函数：参数解析 ─────────────────────────────

test("parseArgs：无参数默认不执行，--yes 才打开真实领取", async () => {
  const { parseArgs } = await load()

  assert.deepEqual(parseArgs([]), { yes: false, help: false, unknown: [] })
  assert.deepEqual(parseArgs(["--yes"]), { yes: true, help: false, unknown: [] })
  assert.deepEqual(parseArgs(["--help"]), { yes: false, help: true, unknown: [] })
  assert.deepEqual(parseArgs(["--nope"]), { yes: false, help: false, unknown: ["--nope"] })
})

// ───────────────────────────── 纯函数：登录态读取与 auth 形状 ─────────────────────────────

test("extractAuthNode：只认 phanthycode，缺了要清晰报错且不回退", async () => {
  const { extractAuthNode } = await load()

  assert.equal(extractAuthNode({ phanthycode: AUTH_NODE }), AUTH_NODE)

  assert.throws(
    () => extractAuthNode({ phanthy: AUTH_NODE }),
    (error) => {
      assert.match(error.message, /phanthycode/)
      assert.match(error.message, /不回退/)
      return true
    },
    "只有 .phanthy 时必须报错，不能静默用它",
  )

  assert.throws(
    () => extractAuthNode({ phanthycode: { type: "oauth" } }),
    /access/,
    "缺 access/key 令牌要明确拒绝",
  )
})

test("buildCheckinAuth：完整保留 auth 形状（含 accountScope / metadata）", async () => {
  const { buildCheckinAuth } = await load()

  const auth = buildCheckinAuth(AUTH_NODE)

  for (const key of [
    "type",
    "access",
    "key",
    "refresh",
    "expires",
    "accountId",
    "email",
    "uid",
    "accountScope",
    "metadata",
  ]) {
    assert.deepEqual(auth[key], AUTH_NODE[key], `丢字段：${key}`)
  }
  assert.notEqual(auth.metadata, AUTH_NODE.metadata, "metadata 应复制一份，不改原对象")
})

// ───────────────────────────── 纯函数：结果与脱敏 ─────────────────────────────

test("summarizeResult：只留 outcome/credit/streak/message", async () => {
  const { summarizeResult } = await load()

  const summary = summarizeResult({
    outcome: "claimed",
    credit: 300,
    streak: 2,
    message: "今日签到完成",
    auth: { access: "secret" },
    installationId: "di_secret",
    privateKey: "secret",
    raw: { anything: true },
  })

  assert.deepEqual(Object.keys(summary).sort(), ["credit", "message", "outcome", "streak"])
  assert.deepEqual(summary, { outcome: "claimed", credit: 300, streak: 2, message: "今日签到完成" })
  assert.deepEqual(summarizeResult(null), { outcome: "", credit: 0, streak: 0, message: "" })
  assert.equal(summarizeResult({ credit: -5, streak: 2.6 }).credit, 0)
  assert.equal(summarizeResult({ streak: 2.6 }).streak, 3)
})

test("maskMessage：手机号 / 邮箱 / token 形状都脱敏", async () => {
  const { maskMessage } = await load()

  const out = maskMessage(
    "联系 13800138000 或 user@example.com；token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln 和 sk-abcdefgh12345678，Bearer abcdefghijklmnop",
  )

  assert.doesNotMatch(out, /13800138000/)
  assert.doesNotMatch(out, /user@example\.com/)
  assert.doesNotMatch(out, /eyJhbGci/)
  assert.doesNotMatch(out, /sk-abcdefgh/)
  assert.doesNotMatch(out, /Bearer\s+abcdefgh/)
  assert.match(out, /<手机号>/)
  assert.match(out, /<邮箱>/)
  assert.match(out, /<token>/)

  assert.equal(maskMessage("今日已签到 +300"), "今日已签到 +300")
  assert.equal(maskMessage(undefined), "")
})

// ───────────────────────────── 行为：无 --yes 只预演 ─────────────────────────────

test("无参数：只打印将执行的影响，绝不调用 checkin", async (t) => {
  const { run } = await load()
  const home = makeHome(t)
  writeStore(home, { phanthycode: AUTH_NODE })

  let called = 0
  const pluginFactory = async () => {
    called += 1
    return { auth: { checkin: async () => assert.fail("无 --yes 时不得执行签到") } }
  }

  const io = capture()
  const result = await run({ argv: [], home, pluginFactory, stdout: io.write, stderr: io.write })

  assert.equal(called, 0, "没 --yes 时插件都不该创建")
  assert.equal(result.code, 0)
  assert.equal(result.executed, false)

  const text = io.text()
  assert.match(text, /--yes/)
  assert.match(text, /不会发推理请求/)
  assert.match(text, /loader/)
  assert.match(text, /设备注册/)
  assert.match(text, /写本机设备密钥/)
  assert.match(text, /注册失败/)
  assert.match(text, /outcome \/ credit \/ streak \/ message/)
  // 不能把任何凭据值打出来
  assert.doesNotMatch(text, /access-value|refresh-value|uid-value|scope-value/)
})

test("预演文案：设备未就绪会先注册再领取，注册失败不领取，且不发推理", async () => {
  const { planLines, buildCheckinAuth } = await load()

  const text = planLines(buildCheckinAuth(AUTH_NODE)).join("\n")

  assert.match(text, /如尚无，会先完成设备注册/)
  assert.match(text, /profile → POST \/api\/oauth\/desktop-installations\/register/)
  assert.match(text, /写本机设备密钥/)
  assert.match(text, /随后才读取状态、领取今日奖励/)
  assert.match(text, /注册失败则直接 failed 且不领取/)
  assert.match(text, /不会发推理请求，也不会调用 loader/)
  // 预演同样不得输出任何凭据值
  assert.doesNotMatch(text, /access-value|refresh-value|uid-value|scope-value/)
})

// ───────────────────────────── 行为：--yes 才真执行（假插件注入）─────────────────────────────

test("--yes：把完整 auth 交给 checkin，输出只含四个字段且已脱敏", async (t) => {
  const { run } = await load()
  const home = makeHome(t)
  writeStore(home, { phanthycode: AUTH_NODE })

  let seenAuth = null
  let seenProvider = null
  const pluginFactory = async (ctx, options) => {
    assert.deepEqual(ctx, {})
    assert.equal(typeof options.fetch, "function", "必须显式注入 fetch")
    return {
      auth: {
        async checkin(getAuth, provider) {
          seenAuth = await getAuth()
          seenProvider = provider
          return {
            outcome: "claimed",
            credit: 300,
            streak: 2,
            message: "今日签到完成（13800138000 / user@example.com / eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln）",
            installationId: "di_should_not_leak",
            auth: { access: "access-value" },
          }
        },
      },
    }
  }

  const io = capture()
  const result = await run({ argv: ["--yes"], home, pluginFactory, stdout: io.write, stderr: io.write })

  assert.equal(result.code, 0)
  assert.equal(result.executed, true)
  assert.deepEqual(seenProvider, { id: "phanthycode" })
  assert.deepEqual(seenAuth, AUTH_NODE, "必须原样传完整 auth 形状")

  const text = io.text()
  assert.match(text, /outcome : claimed/)
  assert.match(text, /credit {2}: 300/)
  assert.match(text, /streak {2}: 2/)
  assert.match(text, /message : 今日签到完成/)
  assert.doesNotMatch(text, /13800138000|user@example\.com|eyJhbGci/)
  assert.doesNotMatch(text, /access-value|refresh-value|di_should_not_leak/)
})

test("签到返回 failed：退出码 1，仍只输出四个字段", async (t) => {
  const { run } = await load()
  const home = makeHome(t)
  writeStore(home, { phanthycode: AUTH_NODE })

  const pluginFactory = async () => ({
    auth: { checkin: async () => ({ outcome: "failed", message: "签到失败（13800138000）" }) },
  })

  const io = capture()
  const result = await run({ argv: ["--yes"], home, pluginFactory, stdout: io.write, stderr: io.write })

  assert.equal(result.code, 1)
  assert.equal(result.executed, true)
  assert.match(io.text(), /outcome : failed/)
  assert.match(io.text(), /credit {2}: 0/)
  assert.doesNotMatch(io.text(), /13800138000/)
})

test("插件抛错：不把堆栈或 token 泄出去，退出码 1", async (t) => {
  const { run } = await load()
  const home = makeHome(t)
  writeStore(home, { phanthycode: AUTH_NODE })

  const pluginFactory = async () => ({
    auth: {
      async checkin() {
        throw new Error("上游 401（user@example.com, refresh-value）")
      },
    },
  })

  const io = capture()
  const result = await run({ argv: ["--yes"], home, pluginFactory, stdout: io.write, stderr: io.write })

  assert.equal(result.code, 1)
  const text = io.text()
  assert.match(text, /outcome : failed/)
  assert.doesNotMatch(text, /user@example\.com|refresh-value/)
})

// ───────────────────────────── 行为：输入错误要清晰 ─────────────────────────────

test("只有 .phanthy 节点：退出码 2、报错指出 phanthycode、不调用插件", async (t) => {
  const { run } = await load()
  const home = makeHome(t)
  writeStore(home, { phanthy: AUTH_NODE })

  let called = 0
  const pluginFactory = async () => {
    called += 1
    return {}
  }

  const io = capture()
  const result = await run({ argv: ["--yes"], home, pluginFactory, stdout: io.write, stderr: io.write })

  assert.equal(called, 0)
  assert.equal(result.code, 2)
  assert.match(io.text(), /phanthycode/)
})

test("登录态文件不存在 / JSON 坏了：退出码 2 且说明路径", async (t) => {
  const { run } = await load()
  const home = makeHome(t)

  const io = capture()
  const missing = await run({ argv: [], home, stdout: io.write, stderr: io.write })
  assert.equal(missing.code, 2)
  assert.match(io.text(), /plugin-auth\.json/)

  writeRawStore(home, "{not json")
  const bad = capture()
  const result = await run({ argv: [], home, stdout: bad.write, stderr: bad.write })
  assert.equal(result.code, 2)
  assert.match(bad.text(), /JSON/)
})

test("未知参数：退出码 2，绝不执行", async (t) => {
  const { run } = await load()
  const home = makeHome(t)
  writeStore(home, { phanthycode: AUTH_NODE })

  let called = 0
  const pluginFactory = async () => {
    called += 1
    return {}
  }

  const io = capture()
  const result = await run({ argv: ["--yolo"], home, pluginFactory, stdout: io.write, stderr: io.write })

  assert.equal(called, 0)
  assert.equal(result.code, 2)
  assert.match(io.text(), /--yolo/)
})
