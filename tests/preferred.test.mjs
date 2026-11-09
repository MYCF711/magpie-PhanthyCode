// `src/preferred.mjs` 的语义锁 —— 「magpie 首选账号」只读解析。
//
// 这块全是「写错不报错、用户看不出」的类型：
//   · 用 accountId / 手机号 / home 当键 → 换一次 token、改一次名，同一个人就变成两个人，
//     邀请挂到别人名下、缓存各写一份，界面一切正常；
//   · 把别的 provider 的行混进来 → 首选账号根本不是你选的那个；
//   · 文件坏了就抛 → 宿主起不来 = 整个插件从列表里消失；
//   · 把 token 带进返回值 → 展示层 / 日志顺手就打出来了。
// 所以每一条都单独钉死。
//
// 全部离线：HOME / USERPROFILE 重定向到 mkdtemp（默认 configDir 的用例也走这份沙箱），
// 不读真实 ~/.config/magpie、不发任何请求。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

// 隔离 HOME：默认 configDir 会拼到 ~/.config/magpie，不能碰真实目录
const sandbox = mkdtempSync(join(tmpdir(), "scaffold-preferred-"))
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox

// 动态 import：模块不存在时整个文件直接红（「失败分支先红后绿」的证据）
const { PREFERRED_REASONS, pickPreferredRow, uidFromAuthEntry, readPreferredUid } =
  await import("../src/preferred.mjs")

// ── 夹具 ────────────────────────────────────────────────────────────

/** 稳定身份：真实插件写的是 fingerprint(accountScope)，形状是 12 位十六进制；这里只要像即可 */
const UID = "9f86d081884c"
const UID_OTHER = "2c26b46b68ff"

/** 假装是凭据的字段 —— 任何一条都不许出现在返回值里（连序列化都不许含） */
const FAKE_TOKENS = Object.freeze({
  token: "fake-token-do-not-leak",
  access: "fake-access-do-not-leak",
  refresh: "fake-refresh-do-not-leak",
  key: "fake-key-do-not-leak",
  authorization: "fake-authorization-do-not-leak",
})

/** magpie `logins.json` 的一行（只复用真实存在的字段） */
function row(overrides = {}) {
  return {
    id: "row-id",
    agent: "plugin:phanthycode",
    user: "user",
    home: "phanthycode",
    seen: "2026-11-09T00:00:00Z",
    on: true,
    auth: "auth-id",
    first: false,
    order: 0,
    ...overrides,
  }
}

/** magpie `plugin-auth.json` 的一条；默认把假凭据也塞进去，验证读取侧不落盘、不返回 */
function authEntry(overrides = {}) {
  return {
    ...FAKE_TOKENS,
    metadata: { userId: UID, accountScope: "scope-9f86d081" },
    accountId: "138****8000",
    ...overrides,
  }
}

/** 新建一个临时配置目录（每次一个，用例间不共享状态） */
function tempConfigDir() {
  return mkdtempSync(join(tmpdir(), "preferred-cfg-"))
}

/**
 * 写夹具文件。传字符串 = 原样写（用来造坏 JSON）；传对象/数组 = JSON.stringify。
 * 没传的那个文件不创建（用来测「文件缺失」）。
 */
function writeConfig(dir, { logins, auth } = {}) {
  if (logins !== undefined) {
    writeFileSync(join(dir, "logins.json"), typeof logins === "string" ? logins : JSON.stringify(logins))
  }
  if (auth !== undefined) {
    writeFileSync(join(dir, "plugin-auth.json"), typeof auth === "string" ? auth : JSON.stringify(auth))
  }
  return dir
}

/** 一条完整的「首选账号」夹具（logins + plugin-auth 都写） */
function fixture({ home = "phanthycode#1", logins, auth } = {}) {
  const dir = tempConfigDir()
  return writeConfig(dir, {
    logins: logins ?? [row({ home, first: true, order: 1 })],
    auth: auth ?? { [home]: authEntry() },
  })
}

// ═══════════════════════════════════════════════════════════════════
// 1. 词表：reason 只从这一组值里出（不是 HTTP 错误码）
// ═══════════════════════════════════════════════════════════════════

test("PREFERRED_REASONS：固定七个值，且被冻结（调用方不必猜字符串）", () => {
  assert.deepEqual(Object.values(PREFERRED_REASONS).sort(), [
    "bad_config",
    "no_auth_entry",
    "no_home",
    "no_logins",
    "no_row",
    "no_uid",
    "ok",
  ])
  assert.ok(Object.isFrozen(PREFERRED_REASONS))
  // 键名是给代码用的，值是给展示/排查用的 —— 两边都锁住
  assert.equal(PREFERRED_REASONS.ok, "ok")
  assert.equal(PREFERRED_REASONS.noLogins, "no_logins")
  assert.equal(PREFERRED_REASONS.noRow, "no_row")
  assert.equal(PREFERRED_REASONS.noHome, "no_home")
  assert.equal(PREFERRED_REASONS.noAuthEntry, "no_auth_entry")
  assert.equal(PREFERRED_REASONS.noUid, "no_uid")
  assert.equal(PREFERRED_REASONS.badConfig, "bad_config")
})

// ═══════════════════════════════════════════════════════════════════
// 2. pickPreferredRow：first:true → 最小正 order → 第一行
// ═══════════════════════════════════════════════════════════════════

test("pickPreferredRow：first === true 优先于 order（哪怕 order 更大）", () => {
  const rows = [
    row({ home: "phanthycode#1", order: 1 }),
    row({ home: "phanthycode#2", order: 2 }),
    row({ home: "phanthycode#3", order: 99, first: true }),
  ]
  const picked = pickPreferredRow(rows, "phanthycode")
  assert.equal(picked, rows[2], "应返回原始行（引用相等），不是复制出来的新对象")
  assert.equal(picked.home, "phanthycode#3")
})

test("pickPreferredRow：没有 first 时取最小正 order（数字比较，不是字典序）", () => {
  const rows = [
    row({ home: "order-10", order: "10" }),
    row({ home: "order-9", order: 9 }),
    row({ home: "order-2", order: "2" }),
    row({ home: "order-3", order: 3 }),
  ]
  assert.equal(pickPreferredRow(rows, "phanthycode").home, "order-2")
})

test("pickPreferredRow：order 非法 / 缺失 / 非正一律忽略，退到第一行", () => {
  const rows = [
    row({ home: "bad-string", order: "not-a-number" }),
    row({ home: "missing" }),
    row({ home: "nan", order: Number.NaN }),
    row({ home: "inf", order: Number.POSITIVE_INFINITY }),
    row({ home: "zero", order: 0 }),
    row({ home: "negative", order: -5 }),
    row({ home: "null", order: null }),
  ]
  assert.equal(pickPreferredRow(rows, "phanthycode").home, "bad-string")
})

test("pickPreferredRow：只看 agent === plugin:<provider> 且 home 非空的行", () => {
  const rows = [
    // 别的 provider 的 first:true 不算
    row({ agent: "plugin:other", home: "other#1", first: true, order: 1 }),
    // agent 多一段（phanthycode#1）是另一个 provider，也不算
    row({ agent: "plugin:phanthycode#1", home: "phanthycode#1", first: true, order: 1 }),
    // 本 provider 但 home 全是空白
    row({ home: "   ", first: true, order: 1 }),
    row({ home: "", order: 1 }),
    row({ home: null, order: 1 }),
    // 真正可用的两行
    row({ home: "phanthycode#2", order: 2 }),
    row({ home: "phanthycode#3", order: 3 }),
  ]
  const picked = pickPreferredRow(rows, "phanthycode")
  assert.equal(picked, rows[5])
  assert.equal(picked.home, "phanthycode#2")
})

test("pickPreferredRow：home 长得像 phanthycode#1 也不按 home 反推 provider", () => {
  const rows = [
    row({ agent: "plugin:other", home: "phanthycode#1", first: true, order: 1 }),
    row({ agent: "plugin:phanthycode", home: "phanthycode#2", order: 2 }),
  ]
  assert.equal(pickPreferredRow(rows, "phanthycode").home, "phanthycode#2")
})

test("pickPreferredRow：没有匹配行 / 非数组 / provider 非法 → null（不抛）", () => {
  assert.equal(pickPreferredRow([], "phanthycode"), null)
  assert.equal(pickPreferredRow(null, "phanthycode"), null)
  assert.equal(pickPreferredRow(undefined, "phanthycode"), null)
  assert.equal(pickPreferredRow({ agent: "plugin:phanthycode", home: "x" }, "phanthycode"), null)
  assert.equal(pickPreferredRow([null, 1, "x", [], true], "phanthycode"), null)
  assert.equal(pickPreferredRow([row()], ""), null)
  assert.equal(pickPreferredRow([row()], "   "), null)
  assert.equal(pickPreferredRow([row()], null), null)
  assert.equal(pickPreferredRow([row()], 42), null)
  assert.equal(pickPreferredRow([row({ agent: "plugin:other" })], "phanthycode"), null)
  assert.equal(pickPreferredRow([row({ home: "" })], "phanthycode"), null)
  assert.equal(pickPreferredRow([row({ home: "  \t\n " })], "phanthycode"), null)
  assert.equal(pickPreferredRow([row({ agent: null })], "phanthycode"), null)
})

test("pickPreferredRow：纯函数 —— 不改输入数组、不重排、不动行对象", () => {
  const rows = [
    row({ home: "order-2", order: 2 }),
    row({ home: "order-1", order: 1 }),
    row({ home: "order-3", order: 3 }),
  ]
  const snapshot = rows.map((r) => ({ ...r }))
  const picked = pickPreferredRow(rows, "phanthycode")

  assert.equal(picked, rows[1])
  assert.deepEqual(rows, snapshot, "输入数组（含行对象）必须原样")
  assert.equal(rows[0].home, "order-2", "不许原地 sort")

  // 冻结数组也能跑：实现里不许出现 sort / splice / push
  const frozen = Object.freeze([...rows])
  assert.equal(pickPreferredRow(frozen, "phanthycode").home, "order-1")
})

// ═══════════════════════════════════════════════════════════════════
// 3. uidFromAuthEntry：只认 metadata.userId
// ═══════════════════════════════════════════════════════════════════

test("uidFromAuthEntry：只从 entry.metadata.userId 取（trim 后非空才要）", () => {
  assert.equal(uidFromAuthEntry({ metadata: { userId: UID } }), UID)
  assert.equal(uidFromAuthEntry({ metadata: { userId: `  ${UID}  ` } }), UID)
  assert.equal(uidFromAuthEntry({ metadata: { userId: UID, accountScope: "scope" } }), UID)
})

test("uidFromAuthEntry：entry.uid / org / accountId 即使长得像指纹也一律不采纳", () => {
  assert.equal(uidFromAuthEntry({ uid: UID }), "")
  assert.equal(uidFromAuthEntry({ org: UID }), "")
  assert.equal(uidFromAuthEntry({ accountId: UID }), "")
  assert.equal(uidFromAuthEntry({ uid: UID, org: UID, accountId: UID }), "")
  // metadata 存在但 userId 不可用 —— 其它位置仍然不采纳（不「兜底」）
  assert.equal(uidFromAuthEntry({ metadata: { userId: "" }, uid: UID, org: UID, accountId: UID }), "")
  assert.equal(uidFromAuthEntry({ metadata: { userId: "   " }, uid: UID }), "")
  assert.equal(uidFromAuthEntry({ metadata: {}, uid: UID }), "")
  assert.equal(uidFromAuthEntry({ metadata: null, uid: UID }), "")
  assert.equal(uidFromAuthEntry({ metadata: [UID], uid: UID }), "")
})

test("uidFromAuthEntry：非字符串 / 非对象 / 退化输入 → 空串（不抛）", () => {
  for (const entry of [
    null,
    undefined,
    "",
    "uid",
    42,
    true,
    [],
    {},
    { metadata: { userId: 42 } },
    { metadata: { userId: null } },
    { metadata: { userId: { toString: () => UID } } },
    { metadata: { userId: [UID] } },
  ]) {
    let v
    assert.doesNotThrow(() => { v = uidFromAuthEntry(entry) }, `不该抛：${JSON.stringify(entry)}`)
    assert.equal(v, "", `应返回空串：${JSON.stringify(entry)}`)
    assert.equal(typeof v, "string")
  }
})

// ═══════════════════════════════════════════════════════════════════
// 4. readPreferredUid：成功路径
// ═══════════════════════════════════════════════════════════════════

test("readPreferredUid：ok —— 返回 {uid, home, accountId, reason}，accountId 只做展示", () => {
  const dir = fixture({ home: "phanthycode#7" })
  const v = readPreferredUid("phanthycode", { configDir: dir })
  assert.deepEqual(v, {
    uid: UID,
    home: "phanthycode#7",
    accountId: "138****8000",
    reason: PREFERRED_REASONS.ok,
  })
  assert.deepEqual(Object.keys(v).sort(), ["accountId", "home", "reason", "uid"])
})

test("readPreferredUid：home 两端空白会被 trim 后再去 plugin-auth.json 找条目", () => {
  const dir = writeConfig(tempConfigDir(), {
    logins: [row({ home: "  phanthycode#8  ", first: true, order: 1 })],
    auth: { "phanthycode#8": authEntry({ accountId: "  显示名  " }) },
  })
  const v = readPreferredUid("phanthycode", { configDir: dir })
  assert.equal(v.reason, "ok")
  assert.equal(v.home, "phanthycode#8")
  assert.equal(v.accountId, "显示名")
})

test("readPreferredUid：accountId 缺失 / 非字符串时是空串（不影响 uid）", () => {
  for (const accountId of [undefined, null, 42, {}, [], true]) {
    const dir = writeConfig(tempConfigDir(), {
      logins: [row({ home: "home#1" })],
      auth: { "home#1": authEntry({ accountId }) },
    })
    const v = readPreferredUid("phanthycode", { configDir: dir })
    assert.equal(v.reason, "ok", `accountId=${JSON.stringify(accountId)}`)
    assert.equal(v.uid, UID)
    assert.equal(typeof v.accountId, "string")
  }
})

test("readPreferredUid：显式 loginsFile / authFile 优先于 configDir 拼出来的路径", () => {
  const dir = tempConfigDir()
  const loginsFile = join(dir, "custom-logins.json")
  const authFile = join(dir, "custom-auth.json")
  writeFileSync(loginsFile, JSON.stringify([row({ home: "home#custom", first: true })]))
  writeFileSync(authFile, JSON.stringify({ "home#custom": authEntry() }))

  const v = readPreferredUid("phanthycode", {
    configDir: join(dir, "no-such-dir"),
    loginsFile,
    authFile,
  })
  assert.equal(v.reason, "ok")
  assert.equal(v.home, "home#custom")
  assert.equal(v.uid, UID)
})

test("readPreferredUid：默认 configDir = ~/.config/magpie（HOME 已重定向到沙箱）", () => {
  const cfg = join(homedir(), ".config", "magpie")
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, "logins.json"), JSON.stringify([row({ home: "home#default", first: true, order: 1 })]))
  writeFileSync(join(cfg, "plugin-auth.json"), JSON.stringify({ "home#default": authEntry({ accountId: "默认账号" }) }))

  const v = readPreferredUid("phanthycode")
  assert.equal(v.reason, PREFERRED_REASONS.ok)
  assert.equal(v.uid, UID)
  assert.equal(v.home, "home#default")
  assert.equal(v.accountId, "默认账号")
})

// ═══════════════════════════════════════════════════════════════════
// 5. readPreferredUid：每个失败分支都能落到对应 reason（且不抛）
// ═══════════════════════════════════════════════════════════════════

test("readPreferredUid：no_logins —— logins.json 根本不存在", () => {
  const dir = writeConfig(tempConfigDir(), { auth: { "home#1": authEntry() } })
  const v = readPreferredUid("phanthycode", { configDir: dir })
  assert.equal(v.reason, PREFERRED_REASONS.noLogins)
  assert.deepEqual(v, { uid: "", home: "", accountId: "", reason: "no_logins" })
})

test("readPreferredUid：bad_config —— logins.json 坏 JSON / 非数组 / 空文件", () => {
  for (const logins of ["{ not json", "", "null", "42", '"array"', "{}", '{"agent":"plugin:phanthycode"}']) {
    const dir = writeConfig(tempConfigDir(), { logins, auth: {} })
    const v = readPreferredUid("phanthycode", { configDir: dir })
    assert.equal(v.reason, PREFERRED_REASONS.badConfig, `logins=${JSON.stringify(logins)}`)
    assert.equal(v.uid, "")
  }
})

test("readPreferredUid：no_row —— 文件是数组，但没有本 provider 的行", () => {
  const cases = [
    [],
    [row({ agent: "plugin:other" })],
    [row({ agent: "plugin:phanthycode#1", home: "phanthycode#1" })],
    [row({ agent: null }), row({ agent: 42 }), null, 1, "x"],
  ]
  for (const logins of cases) {
    const dir = writeConfig(tempConfigDir(), { logins, auth: {} })
    const v = readPreferredUid("phanthycode", { configDir: dir })
    assert.equal(v.reason, PREFERRED_REASONS.noRow, JSON.stringify(logins))
    assert.equal(v.home, "")
  }
})

test("readPreferredUid：no_home —— 本 provider 的行 home 全是空 / 空白 / 非字符串", () => {
  const logins = [
    row({ home: "" }),
    row({ home: "   " }),
    row({ home: "\t\n" }),
    row({ home: null }),
    row({ home: 42 }),
    row({ home: {} }),
  ]
  const dir = writeConfig(tempConfigDir(), { logins, auth: {} })
  const v = readPreferredUid("phanthycode", { configDir: dir })
  assert.equal(v.reason, PREFERRED_REASONS.noHome)
  assert.equal(v.home, "")
  assert.equal(v.uid, "")
})

test("readPreferredUid：no_auth_entry —— plugin-auth.json 缺失 / 没有这个 home / 条目不是对象", () => {
  // 文件缺失
  const missing = writeConfig(tempConfigDir(), { logins: [row({ home: "home#1" })] })
  assert.equal(readPreferredUid("phanthycode", { configDir: missing }).reason, PREFERRED_REASONS.noAuthEntry)

  // 有条目但 key 不是首选 home
  const absent = writeConfig(tempConfigDir(), {
    logins: [row({ home: "home#1" })],
    auth: { "home#2": authEntry() },
  })
  const absentResult = readPreferredUid("phanthycode", { configDir: absent })
  assert.equal(absentResult.reason, PREFERRED_REASONS.noAuthEntry)
  assert.equal(absentResult.home, "home#1", "失败时也回传已解析的 home，便于排查")

  // 条目是原始值 / 数组 / null
  for (const entry of ["uid", 42, null, [], true]) {
    const dir = writeConfig(tempConfigDir(), { logins: [row({ home: "home#1" })], auth: { "home#1": entry } })
    const v = readPreferredUid("phanthycode", { configDir: dir })
    assert.equal(v.reason, PREFERRED_REASONS.noAuthEntry, `entry=${JSON.stringify(entry)}`)
    assert.equal(v.uid, "")
  }
})

test("readPreferredUid：no_uid —— 条目在，但 metadata.userId 不是非空字符串", () => {
  const entries = [
    { uid: UID, org: UID, accountId: "138****8000" },
    { org: UID },
    { accountId: UID },
    { metadata: {} },
    { metadata: null },
    { metadata: { userId: "" } },
    { metadata: { userId: "   " } },
    { metadata: { userId: 42 } },
    { metadata: { userId: null } },
    { metadata: [UID] },
  ]
  for (const entry of entries) {
    const dir = writeConfig(tempConfigDir(), { logins: [row({ home: "home#1" })], auth: { "home#1": entry } })
    const v = readPreferredUid("phanthycode", { configDir: dir })
    assert.equal(v.reason, PREFERRED_REASONS.noUid, JSON.stringify(entry))
    assert.equal(v.uid, "")
    assert.equal(v.home, "home#1")
  }
})

test("readPreferredUid：bad_config —— plugin-auth.json 坏 JSON / 非对象 / 空文件", () => {
  for (const auth of ["{ nope", "", "[]", "null", "42", '"text"', "true"]) {
    const dir = writeConfig(tempConfigDir(), { logins: [row({ home: "home#1" })], auth })
    const v = readPreferredUid("phanthycode", { configDir: dir })
    assert.equal(v.reason, PREFERRED_REASONS.badConfig, `auth=${JSON.stringify(auth)}`)
    assert.equal(v.home, "home#1", "已解析的 home 照常回传")
  }
})

test("readPreferredUid：bad_config —— provider / 选项形状不合法（不抛）", () => {
  const dir = tempConfigDir()
  const badProviders = ["", "   ", null, undefined, 42, true, {}, [], () => {}]
  for (const provider of badProviders) {
    let v
    assert.doesNotThrow(() => { v = readPreferredUid(provider, { configDir: dir }) })
    assert.equal(v.reason, PREFERRED_REASONS.badConfig, `provider=${String(provider)}`)
    assert.equal(v.uid, "")
  }

  const badOptions = [
    null,
    [],
    "options",
    42,
    () => {},
    { configDir: 42 },
    { configDir: "" },
    { loginsFile: "" },
    { loginsFile: null },
    { loginsFile: 42 },
    { authFile: "" },
    { authFile: [] },
    { authFile: {} },
  ]
  for (const options of badOptions) {
    let v
    assert.doesNotThrow(() => { v = readPreferredUid("phanthycode", options) })
    assert.equal(v.reason, PREFERRED_REASONS.badConfig, `options=${JSON.stringify(options)}`)
  }
})

test("readPreferredUid：任何输入都不抛，且返回形状固定（四个键都是字符串）", () => {
  const providers = [undefined, null, 0, "", "   ", "phanthycode", {}, [], Symbol("p")]
  const optionsList = [undefined, null, [], {}, { configDir: tempConfigDir() }, { loginsFile: Symbol("x") }]
  for (const provider of providers) {
    for (const options of optionsList) {
      let v
      assert.doesNotThrow(() => { v = readPreferredUid(provider, options) })
      assert.deepEqual(Object.keys(v).sort(), ["accountId", "home", "reason", "uid"])
      for (const key of ["uid", "home", "accountId", "reason"]) assert.equal(typeof v[key], "string", `${key} 必须是字符串`)
      assert.ok(Object.values(PREFERRED_REASONS).includes(v.reason), `reason 必须来自词表：${v.reason}`)
    }
  }
})

// ═══════════════════════════════════════════════════════════════════
// 6. 安全面：token / access / refresh 绝不出现在返回值里
// ═══════════════════════════════════════════════════════════════════

test("readPreferredUid：成功路径不含 token / access / refresh（连序列化都不含）", () => {
  const dir = fixture({ home: "home#token" })
  const v = readPreferredUid("phanthycode", { configDir: dir })

  assert.equal(v.reason, PREFERRED_REASONS.ok)
  for (const [key, value] of Object.entries(FAKE_TOKENS)) {
    assert.equal(Object.hasOwn(v, key), false, `结果里不该有 ${key}`)
    assert.equal(JSON.stringify(v).includes(value), false, `序列化结果不该含 ${key} 的值`)
  }
})

test("readPreferredUid：失败分支同样不泄露凭据（每条 reason 都过一遍）", () => {
  const cases = [
    // no_logins
    writeConfig(tempConfigDir(), { auth: { "home#1": authEntry() } }),
    // bad_config（logins 坏）
    writeConfig(tempConfigDir(), { logins: "{ nope", auth: { "home#1": authEntry() } }),
    // no_row
    writeConfig(tempConfigDir(), { logins: [row({ agent: "plugin:other" })], auth: { "home#1": authEntry() } }),
    // no_home
    writeConfig(tempConfigDir(), { logins: [row({ home: "" })], auth: { "home#1": authEntry() } }),
    // no_auth_entry
    writeConfig(tempConfigDir(), { logins: [row({ home: "home#1" })], auth: {} }),
    // no_uid
    writeConfig(tempConfigDir(), { logins: [row({ home: "home#1" })], auth: { "home#1": { ...FAKE_TOKENS } } }),
    // bad_config（auth 坏）
    writeConfig(tempConfigDir(), { logins: [row({ home: "home#1" })], auth: "{ nope" }),
  ]

  const reasons = new Set()
  for (const dir of cases) {
    const v = readPreferredUid("phanthycode", { configDir: dir })
    reasons.add(v.reason)
    for (const [key, value] of Object.entries(FAKE_TOKENS)) {
      assert.equal(Object.hasOwn(v, key), false, `结果里不该有 ${key}`)
      assert.equal(JSON.stringify(v).includes(value), false, `序列化结果不该含 ${key} 的值`)
    }
  }
  // 词表里除了 ok 的六个失败值都出现过（用例覆盖自证）
  assert.deepEqual([...reasons].sort(), [
    "bad_config",
    "no_auth_entry",
    "no_home",
    "no_logins",
    "no_row",
    "no_uid",
  ])
})
