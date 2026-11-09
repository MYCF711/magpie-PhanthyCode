// 邀请源策略 + 本地缓存的语义锁。
//
// 这块全是「写错不报错、用户看不出」的类型：
//   · 自动源跟错了账号 → 新号注册挂到一个旧号名下，上级奖励给了别人，界面一切正常；
//   · 首选没码时偷偷换了别的账号 → 邀请人不是你选的那个人，同样没有任何报错；
//   · 自动派生的码写进了预留文件 → 用户自己填的那条链接被覆盖，链尾兜底没了；
//   · 每账号的码共用一个键 → 第二个账号进来就串号，A 的码挂到 B 名下。
// 所以每一条都单独钉死。
//
// 全部离线：HOME / USERPROFILE 重定向到 mkdtemp，不碰真实 ~/.cache，也不发任何请求。

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// 隔离 HOME：缓存写在 ~/.cache/magpie 下，不能污染真实目录
const sandbox = mkdtempSync(join(tmpdir(), "scaffold-invite-source-"))
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox

const { createInviteSourceStore, parseInviteShareCode, preferredHome } = await import("../src/invite-source.mjs")
const { createInviteStore } = await import("../src/invite.mjs")

const CACHE = join(sandbox, ".cache", "magpie")
mkdirSync(CACHE, { recursive: true })

/** 合法长码（白名单字符，且不是「人类可读短码」形状） */
const CODE_A = "AAAAlo1ngCo2de3AAAABBBB"
const CODE_B = "BBBBlo1ngCo2de3BBBBBBBB"
const CODE_C = "CCCCLo1ngCo2de3CCCCCCCC"
const SHARE_A = `https://code.phanthy.com/r/${CODE_A}`

const textOf = (file) => readFileSync(file, "utf8")

// ═══════════════════════════════════════════════════════════════════
// 1. 邀请链接解析：只认官方 /r/<code> 与裸长码
// ═══════════════════════════════════════════════════════════════════

test("parseInviteShareCode：完整官方链接 / /r/ 路径 / 裸长码，一律归一成白名单 code", () => {
  const cases = [
    [`https://code.phanthy.com/r/${CODE_A}`, CODE_A, "url"],
    [`  https://code.phanthy.com/r/${CODE_A}  `, CODE_A, "url"],
    ["https://code.phanthy.com/r/abc123", "abc123", "url"],
    // 分享按钮复制出来的链接常带跟踪参数：origin 已校验，query 不影响 code
    ["https://code.phanthy.com/r/abc123?from=share", "abc123", "url"],
    ["https://code.phanthy.com/r/abc123#x", "abc123", "url"],
    ["/r/abc123", "abc123", "path"],
    ["/r/abc123?from=share", "abc123", "path"],
    ["r/abc123", "abc123", "path"],
    ["/r/abc123/", "abc123", "path"],
    ["abc123", "abc123", "bare"],
    ["A.B_c-1", "A.B_c-1", "bare"],
  ]
  for (const [input, code, form] of cases) {
    const v = parseInviteShareCode(input)
    assert.equal(v.ok, true, `应接受：${input}`)
    assert.equal(v.code, code, `code 归一错误：${input}`)
    assert.equal(v.form, form, `形态判定错误：${input}`)
    assert.equal(v.shareUrl, `https://code.phanthy.com/r/${code}`)
    assert.equal(v.reason, "")
  }
})

test("parseInviteShareCode：别的 origin / 非 https / 协议相对 / userinfo 一律拒绝", () => {
  const cases = [
    ["https://evil.example.com/r/abc123", "untrusted_origin"],
    ["https://code.phanthy.com.evil.example/r/abc123", "untrusted_origin"],
    ["https://evil.phanthy.com/r/abc123", "untrusted_origin"],
    ["https://code.phanthy.com:8443/r/abc123", "untrusted_origin"],
    ["//code.phanthy.com/r/abc123", "untrusted_origin"],
    ["https://user:user@code.phanthy.com/r/abc123", "untrusted_origin"],
    ["http://code.phanthy.com/r/abc123", "untrusted_scheme"],
    ["javascript:alert(1)", "untrusted_scheme"],
    ["data:text/html,r/abc123", "untrusted_scheme"],
  ]
  for (const [input, reason] of cases) {
    const v = parseInviteShareCode(input)
    assert.equal(v.ok, false, `应拒绝：${input}`)
    assert.equal(v.reason, reason, `拒绝原因错误：${input}`)
    assert.equal(v.code, "")
    assert.equal(v.shareUrl, "")
  }
})

test("parseInviteShareCode：短 invite_code / 凭据 / state 形状一律拒绝（不许拿它造 /r/ 链接）", () => {
  const cases = [
    // 人类可读邀请码（注册表单里手填那种）：塞进 /r/ 只会 404，属于静默失效
    ["abcd-efgh-jk23", "short_invite_code"],
    ["ABCD-EFGH-JK23", "short_invite_code"],
    ["AB-CD-EF", "short_invite_code"],
    // referral_state：按链接即时签发的短期令牌，不是邀请码
    ["rs1.AAAA.BBBB", "credential"],
    // JWT：三段点分。运行时拼接 —— 公开仓库里不留「看起来像真凭据」的字面量，
    // 运行时仍是合法 JWT 形状，被拒的语义不变。
    [["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "PLACEHOLDER-SIGNATURE"].join("."), "credential"],
    ["di_abcdefghijklmnopqrstuvwxyz", "credential"],
    ["Bearer abcdefghijklmnop", "credential"],
    ["sk-live-abcdefghijklmnop", "credential"],
  ]
  for (const [input, reason] of cases) {
    const v = parseInviteShareCode(input)
    assert.equal(v.ok, false, `应拒绝：${input}`)
    assert.equal(v.reason, reason, `拒绝原因错误：${input}`)
    assert.equal(v.code, "")
  }
})

test("parseInviteShareCode：路径 / 空白 / 超长 / 非白名单字符一律 invalid_code", () => {
  const cases = [
    // 空 / 非字符串
    ["", "empty"],
    [null, "empty"],
    [undefined, "empty"],
    [123, "empty"],
    ["   ", "empty"],
    // 字符 / 形状不对
    ["abc def", "invalid_code"],
    ["abc/def", "invalid_code"],
    ["../etc/passwd", "invalid_code"],
    [".", "invalid_code"],
    ["-", "invalid_code"],
    ["...", "invalid_code"],
    ["a".repeat(201), "invalid_code"],
    ["https://code.phanthy.com/r/", "invalid_code"],
    ["https://code.phanthy.com/r/abc/def", "invalid_code"],
    ["https://code.phanthy.com/r/abc%2Fdef", "invalid_code"],
    ["https://code.phanthy.com/login?next=/r/abc", "invalid_code"],
    ["/login?referral_state=rs1.x", "invalid_code"],
  ]
  for (const [input, reason] of cases) {
    const v = parseInviteShareCode(input)
    assert.equal(v.ok, false, `应拒绝：${String(input)}`)
    assert.equal(v.reason, reason, `拒绝原因错误：${String(input)}`)
    assert.equal(v.code, "")
    assert.equal(v.shareUrl, "")
  }
})

// ═══════════════════════════════════════════════════════════════════
// 2. 账号索引：firstSeenAt 只写一次
// ═══════════════════════════════════════════════════════════════════

test("noteAccount：firstSeenAt 只写一次，重登旧号不改它（否则自动源会被旧号抢走）", () => {
  const s = createInviteSourceStore("zzsrc-first-seen")
  s.noteAccount({ uid: "u1", accountScope: "scope-1", accountId: "旧的显示名", at: 1_000 })
  s.noteAccount({ uid: "u2", accountScope: "scope-2", accountId: "新号", at: 2_000 })
  // 重登旧号：时间更晚，但 firstSeenAt 必须留在 1000
  s.noteAccount({ uid: "u1", accountScope: "scope-1", accountId: "改名后", at: 9_000 })

  const accounts = s.readAccounts()
  assert.equal(accounts.u1.firstSeenAt, 1_000)
  assert.equal(accounts.u1.lastSeenAt, 9_000)
  assert.equal(accounts.u1.accountId, "改名后")
  assert.equal(accounts.u1.accountScope, "scope-1")
  assert.equal(accounts.u2.firstSeenAt, 2_000)

  // 「最新」仍是 u2：重登旧号不许把下一次注册挂到旧号名下
  s.saveCode({ uid: "u1", code: CODE_A, at: 1_000 })
  s.saveCode({ uid: "u2", code: CODE_B, at: 2_000 })
  assert.equal(s.resolve({ preferFirst: false }).uid, "u2")
})

test("noteAccount：空 uid 不写、不建账号（uid 必须是 metadata.userId 的稳定指纹）", () => {
  const s = createInviteSourceStore("zzsrc-blank-uid")
  assert.equal(s.noteAccount({ uid: "", accountScope: "s", accountId: "a" }), null)
  assert.equal(s.noteAccount({ uid: "   ", accountScope: "s", accountId: "a" }), null)
  assert.equal(s.noteAccount({ accountScope: "s", accountId: "a" }), null)
  assert.deepEqual(s.readAccounts(), {})
})

// ═══════════════════════════════════════════════════════════════════
// 3. 选择算法：off = 最新（没码往前退），on = 首选（没码就 reserved）
// ═══════════════════════════════════════════════════════════════════

test("resolve：off = 最新首次见到的账号；它没码就退回上一个有码的账号", () => {
  const s = createInviteSourceStore("zzsrc-off")
  s.noteAccount({ uid: "older", accountScope: "scope-old", accountId: "旧号", at: 1_000 })
  s.saveCode({ uid: "older", code: CODE_A, at: 1_000 })
  s.noteAccount({ uid: "newer", accountScope: "scope-new", accountId: "新号", at: 2_000 })

  // 最新那个还没有码 → 用上一个可用的，而不是「不带邀请」
  const first = s.resolve({ preferFirst: false })
  assert.equal(first.kind, "latest")
  assert.equal(first.uid, "older")
  assert.equal(first.code, CODE_A)
  assert.equal(first.shareUrl, SHARE_A)
  assert.equal(first.accountScope, "scope-old")
  assert.equal(first.accountId, "旧号")
  assert.equal(first.reason, "")

  // 最新那个拿到码 → 立刻跟过去
  s.saveCode({ uid: "newer", code: CODE_B, at: 2_000 })
  const second = s.resolve({ preferFirst: false })
  assert.equal(second.kind, "latest")
  assert.equal(second.uid, "newer")
  assert.equal(second.code, CODE_B)
})

test("resolve：off 跳过 eligible===false 的账号（死号不参与），仍往前退", () => {
  const s = createInviteSourceStore("zzsrc-off-dead")
  s.noteAccount({ uid: "older", accountScope: "scope-old", accountId: "旧号", at: 1_000 })
  s.saveCode({ uid: "older", code: CODE_A, at: 1_000 })
  s.noteAccount({ uid: "newer", accountScope: "scope-new", accountId: "新号", at: 2_000 })
  s.saveCode({ uid: "newer", code: CODE_B, at: 2_000 })

  s.markEligibility({ uid: "newer", eligible: false, reason: "desktop_required" })
  const v = s.resolve({ preferFirst: false })
  assert.equal(v.uid, "older")
  assert.equal(v.code, CODE_A)

  // 判死的那条码还在磁盘上，但绝不会被选中
  assert.equal(s.readCode("newer").code, CODE_B)
  // 资格恢复后又能被选中
  s.markEligibility({ uid: "newer", eligible: true })
  assert.equal(s.resolve({ preferFirst: false }).uid, "newer")
})

test("resolve：on = 首选账号，即使它不是最新那个（首选优先）", () => {
  const s = createInviteSourceStore("zzsrc-on")
  s.noteAccount({ uid: "old", accountScope: "scope-old", accountId: "首选", at: 1_000 })
  s.saveCode({ uid: "old", code: CODE_A, at: 1_000 })
  s.noteAccount({ uid: "new", accountScope: "scope-new", accountId: "最新", at: 2_000 })
  s.saveCode({ uid: "new", code: CODE_B, at: 2_000 })

  const v = s.resolve({ preferFirst: true, preferredUid: "old" })
  assert.equal(v.kind, "preferred")
  assert.equal(v.uid, "old")
  assert.equal(v.code, CODE_A)
  assert.equal(v.accountScope, "scope-old")
  assert.equal(v.accountId, "首选")
  assert.equal(v.reason, "")
})

test("resolve：首选没码 → 只回 reserved，绝不静默换别的账号", () => {
  const s = createInviteSourceStore("zzsrc-on-nocode")
  s.noteAccount({ uid: "old", accountScope: "scope-old", accountId: "有码的旧号", at: 1_000 })
  s.saveCode({ uid: "old", code: CODE_A, at: 1_000 })
  s.noteAccount({ uid: "preferred", accountScope: "scope-p", accountId: "首选", at: 2_000 })

  const v = s.resolve({
    preferFirst: true,
    preferredUid: "preferred",
    reservedCode: SHARE_A.replace(CODE_A, CODE_C),
  })
  assert.equal(v.kind, "reserved")
  assert.equal(v.code, CODE_C)
  assert.equal(v.uid, "")
  assert.equal(v.accountScope, "")
  assert.equal(v.accountId, "")
  assert.equal(v.reason, "preferred_no_code")
  // 关键：不是 old 的码
  assert.notEqual(v.code, CODE_A)

  // 连预留码都没有 → 空，而不是「借」old 的码
  const none = s.resolve({ preferFirst: true, preferredUid: "preferred" })
  assert.equal(none.kind, "none")
  assert.equal(none.code, "")
  assert.equal(none.reason, "preferred_no_code")
})

test("resolve：首选被判死 / 首选 uid 未知 / 没给首选 → 都只回 reserved", () => {
  const s = createInviteSourceStore("zzsrc-on-blocked")
  s.noteAccount({ uid: "old", accountScope: "scope-old", accountId: "有码的旧号", at: 1_000 })
  s.saveCode({ uid: "old", code: CODE_A, at: 1_000 })
  s.noteAccount({ uid: "dead", accountScope: "scope-d", accountId: "死号", at: 3_000 })
  s.saveCode({ uid: "dead", code: CODE_B, at: 3_000 })
  s.markEligibility({ uid: "dead", eligible: false, reason: "sign_in_expired" })

  const reserved = { reservedCode: CODE_C }

  const dead = s.resolve({ preferFirst: true, preferredUid: "dead", ...reserved })
  assert.equal(dead.kind, "reserved")
  assert.equal(dead.reason, "preferred_ineligible")

  const ghost = s.resolve({ preferFirst: true, preferredUid: "ghost", ...reserved })
  assert.equal(ghost.kind, "reserved")
  assert.equal(ghost.reason, "preferred_no_code")

  const missing = s.resolve({ preferFirst: true, ...reserved })
  assert.equal(missing.kind, "reserved")
  assert.equal(missing.reason, "preferred_missing")
  assert.equal(missing.code, CODE_C)
})

test("resolve：什么都没有 → 空（不抛、不造码），off 时才落到 reserved", () => {
  const s = createInviteSourceStore("zzsrc-empty")
  const empty = s.resolve({ preferFirst: false })
  assert.equal(empty.kind, "none")
  assert.equal(empty.code, "")
  assert.equal(empty.shareUrl, "")
  assert.equal(empty.reason, "no_account_code")

  // 有预留链接（含完整 URL 形态）→ 兜底
  const v = s.resolve({ preferFirst: false, reservedCode: `  ${SHARE_A}  ` })
  assert.equal(v.kind, "reserved")
  assert.equal(v.code, CODE_A)
  assert.equal(v.shareUrl, SHARE_A)
  assert.equal(v.uid, "")
})

test("resolve：预留值是短 invite_code / 非法 → 不当作源，且说明原因", () => {
  const s = createInviteSourceStore("zzsrc-reserved-bad")
  for (const bad of ["abcd-efgh-jk23", "https://evil.example.com/r/abc123", "abc def"]) {
    const v = s.resolve({ preferFirst: false, reservedCode: bad })
    assert.equal(v.kind, "none", `不许用：${bad}`)
    assert.equal(v.code, "")
    assert.equal(v.reason, "reserved_unusable")
  }
})

test("resolve：返回形状固定（调用方不必猜字段）", () => {
  const s = createInviteSourceStore("zzsrc-shape")
  const keys = ["accountId", "accountScope", "code", "kind", "reason", "shareUrl", "uid"]
  assert.deepEqual(Object.keys(s.resolve({})).sort(), keys)

  s.noteAccount({ uid: "u1", accountScope: "scope-1", accountId: "a1", at: 1_000 })
  s.saveCode({ uid: "u1", code: CODE_A, at: 1_000 })
  const v = s.resolve({ preferFirst: false })
  assert.deepEqual(Object.keys(v).sort(), keys)
  assert.equal(v.shareUrl, SHARE_A)
})

// ═══════════════════════════════════════════════════════════════════
// 4. 预留值不许被自动派生覆盖
// ═══════════════════════════════════════════════════════════════════

test("预留码不被自动派生覆盖：本模块只写 accounts / code，绝不碰 <prefix>-invite.json", () => {
  const prefix = "zzsrc-reserved"
  const reserved = createInviteStore(prefix)
  reserved.write("RESERVEDcodeA1", { source: "chosen" })
  const before = readFileSync(reserved.file)

  const s = createInviteSourceStore(prefix)
  s.noteAccount({ uid: "u1", accountScope: "scope-1", accountId: "a1", at: 1_000 })
  s.saveCode({ uid: "u1", code: CODE_A, at: 1_000 })
  s.markEligibility({ uid: "u1", eligible: true, reason: "" })
  s.resolve({ preferFirst: true, preferredUid: "u1", reservedCode: "RESERVEDcodeA1" })
  s.resolve({ preferFirst: false })
  s.resolve({ preferFirst: false, reservedCode: "abcd-efgh-jk23" })

  // 逐字节不变，读出来还是用户自己填的那条
  assert.deepEqual(readFileSync(reserved.file), before)
  assert.equal(reserved.read(), "RESERVEDcodeA1")

  // 本模块自己的文件就那两个命名，没有第三种
  const mine = readdirSync(CACHE).filter((n) => n.startsWith(`${prefix}-`) && n !== `${prefix}-invite.json`)
  for (const name of mine) {
    assert.match(name, new RegExp(`^${prefix}-invite-(?:accounts|code-[A-Za-z0-9_-]{1,64})\\.json$`), name)
  }
})

// ═══════════════════════════════════════════════════════════════════
// 5. 每账号一个文件：换账号不串码
// ═══════════════════════════════════════════════════════════════════

test("saveCode / readCode：按 uid 隔离；同显示名不同 uid 也不撞", () => {
  const s = createInviteSourceStore("zzsrc-isolate")
  // accountId 只是显示名（会打码、可重名），绝不能作键
  s.noteAccount({ uid: "uid-1", accountScope: "scope-1", accountId: "138****8000", at: 1_000 })
  s.noteAccount({ uid: "uid-2", accountScope: "scope-2", accountId: "138****8000", at: 2_000 })

  s.saveCode({ uid: "uid-1", code: CODE_A, at: 1_000 })
  s.saveCode({ uid: "uid-2", code: CODE_B, at: 2_000 })

  assert.equal(s.readCode("uid-1").code, CODE_A)
  assert.equal(s.readCode("uid-2").code, CODE_B)
  assert.equal(s.readCode("uid-1").shareUrl, SHARE_A)
  assert.notEqual(s.codeFile("uid-1"), s.codeFile("uid-2"))
  assert.equal(s.readCode("uid-3"), null)

  // 索引只放身份与时间，不放码
  const index = textOf(s.indexFile)
  assert.ok(!index.includes(CODE_A))
  assert.ok(!index.includes(CODE_B))
  assert.ok(index.includes("uid-1"))
  assert.ok(index.includes("uid-2"))
})

test("文件名不承载 uid 的危险字符（不许路径穿越、不许落盘到缓存目录外）", () => {
  const s = createInviteSourceStore("zzsrc-safe-name")
  const weird = "../../etc/passwd"
  s.noteAccount({ uid: weird, accountScope: "scope-w", accountId: "怪 uid", at: 1_000 })
  s.saveCode({ uid: weird, code: CODE_A, at: 1_000 })

  const names = readdirSync(CACHE).filter((n) => n.startsWith("zzsrc-safe-name-invite-code-"))
  assert.equal(names.length, 1)
  assert.match(names[0], /^zzsrc-safe-name-invite-code-[A-Za-z0-9_-]{1,64}\.json$/)
  // 换个进程也能读回同一个账号
  assert.equal(s.readCode(weird).code, CODE_A)
  assert.ok(!existsSync(join(sandbox, "etc")))
})

// ═══════════════════════════════════════════════════════════════════
// 6. 落盘内容：只有白名单字段，没有 token / state
// ═══════════════════════════════════════════════════════════════════

test("落盘只存白名单字段：token / referralState / authorization 一律不进文件", () => {
  const s = createInviteSourceStore("zzsrc-secrets")
  s.noteAccount({
    uid: "u1",
    accountScope: "scope-1",
    accountId: "a1",
    at: 1_000,
    token: "SECRET-TOKEN",
    access: "SECRET-TOKEN",
    referralState: "rs1.SECRET",
  })
  s.saveCode({
    uid: "u1",
    code: CODE_A,
    at: 1_000,
    token: "SECRET-TOKEN",
    access_token: "SECRET-TOKEN",
    referralState: "rs1.SECRET",
    authorization: "Bearer SECRET-TOKEN",
  })
  s.markEligibility({ uid: "u1", eligible: true, reason: "ok" })

  const index = textOf(s.indexFile)
  const code = textOf(s.codeFile("u1"))
  for (const text of [index, code]) {
    assert.ok(!text.includes("SECRET-TOKEN"), "不许把凭据写进缓存")
    assert.ok(!text.includes("rs1."), "不许把 referral_state 写进缓存")
    assert.doesNotMatch(text, /"(?:token|access|access_token|refresh|referralState|authorization)"/)
  }

  assert.deepEqual(Object.keys(JSON.parse(code)).sort(), ["at", "code", "shareUrl", "slot", "uid"])
  assert.deepEqual(
    Object.keys(JSON.parse(index).u1).sort(),
    ["accountId", "accountScope", "eligible", "firstSeenAt", "lastSeenAt", "reason"],
  )
})

test("saveCode：空码 / 非法码 / 短码绝不覆盖旧值（空值不写是硬规矩）", () => {
  const s = createInviteSourceStore("zzsrc-no-overwrite")
  s.saveCode({ uid: "u1", code: CODE_A, at: 1_000 })

  assert.equal(s.saveCode({ uid: "u1", code: "", at: 2_000 }), null)
  assert.equal(s.saveCode({ uid: "u1", code: "   ", at: 3_000 }), null)
  assert.equal(s.saveCode({ uid: "u1", code: "abcd-efgh-jk23", at: 4_000 }), null)
  assert.equal(s.saveCode({ uid: "u1", code: "rs1.x", at: 5_000 }), null)

  assert.equal(s.readCode("u1").code, CODE_A)
})

test("saveCode：上游给的跨 origin share_url 绝不落盘，改用 code 派生", () => {
  const s = createInviteSourceStore("zzsrc-share-url")
  s.saveCode({ uid: "u1", code: CODE_A, shareUrl: `https://evil.example.com/r/${CODE_A}`, slot: 1, at: 1_000 })
  assert.equal(s.readCode("u1").shareUrl, SHARE_A)
  assert.ok(!textOf(s.codeFile("u1")).includes("evil.example.com"))

  // 同 origin 但 code 对不上 → 同样丢弃，只认显式 code
  s.saveCode({ uid: "u2", code: CODE_B, shareUrl: SHARE_A, slot: 2, at: 1_000 })
  const second = s.readCode("u2")
  assert.equal(second.code, CODE_B)
  assert.equal(second.shareUrl, `https://code.phanthy.com/r/${CODE_B}`)
  assert.equal(second.slot, 2)
})

// ═══════════════════════════════════════════════════════════════════
// 7. 容错：坏文件 / 未知账号一律当「没有」，不抛
// ═══════════════════════════════════════════════════════════════════

test("readCode / readAccounts：坏 JSON、坏码、坏索引都当没有，不抛", () => {
  const s = createInviteSourceStore("zzsrc-corrupt")
  s.noteAccount({ uid: "u0", accountScope: "scope-0", accountId: "a0", at: 1_000 })

  writeFileSync(s.codeFile("u1"), "{not json")
  assert.equal(s.readCode("u1"), null)

  writeFileSync(s.codeFile("u2"), JSON.stringify({ code: "abcd-efgh-jk23", at: 1 }))
  assert.equal(s.readCode("u2"), null)

  writeFileSync(s.indexFile, "[1,2,3]")
  assert.deepEqual(s.readAccounts(), {})
  assert.equal(s.resolve({ preferFirst: false }).kind, "none")
})

test("markEligibility：只给已经见过的账号记资格（不凭空造账号，也不改 firstSeenAt）", () => {
  const s = createInviteSourceStore("zzsrc-eligibility")
  assert.equal(s.markEligibility({ uid: "ghost", eligible: true }), null)
  assert.deepEqual(s.readAccounts(), {})

  s.noteAccount({ uid: "u1", accountScope: "scope-1", accountId: "a1", at: 1_000 })
  const v = s.markEligibility({ uid: "u1", eligible: false, reason: "desktop_required", at: 9_000 })
  assert.equal(v.eligible, false)
  assert.equal(v.reason, "desktop_required")
  assert.equal(v.firstSeenAt, 1_000)
  assert.equal(v.lastSeenAt, 1_000)

  // 非布尔值不改变已有结论
  s.markEligibility({ uid: "u1", eligible: "yes" })
  assert.equal(s.readAccounts().u1.eligible, false)

  // 清空 reason
  s.markEligibility({ uid: "u1", eligible: true, reason: "" })
  assert.equal(s.readAccounts().u1.eligible, true)
  assert.equal(s.readAccounts().u1.reason, undefined)
})

// ═══════════════════════════════════════════════════════════════════
// 8. 落盘方式：原子、无临时文件残留、POSIX 0600
// ═══════════════════════════════════════════════════════════════════

test("落盘：原子替换（无 .tmp 残留）、JSON 完整、POSIX 权限 0600", () => {
  const s = createInviteSourceStore("zzsrc-atomic")
  s.noteAccount({ uid: "u1", accountScope: "scope-1", accountId: "a1", at: 1_000 })
  s.saveCode({ uid: "u1", code: CODE_A, at: 1_000 })

  assert.deepEqual(readdirSync(CACHE).filter((n) => n.endsWith(".tmp")), [])
  assert.doesNotThrow(() => JSON.parse(textOf(s.indexFile)))
  assert.doesNotThrow(() => JSON.parse(textOf(s.codeFile("u1"))))

  if (process.platform !== "win32") {
    assert.equal(statSync(s.indexFile).mode & 0o777, 0o600)
    assert.equal(statSync(s.codeFile("u1")).mode & 0o777, 0o600)
  }
})

test("createInviteSourceStore：只写 ~/.cache/magpie（不碰 ~/.config/magpie）", () => {
  const s = createInviteSourceStore("zzsrc-dir")
  s.noteAccount({ uid: "u1", accountScope: "scope-1", accountId: "a1", at: 1_000 })
  s.saveCode({ uid: "u1", code: CODE_A, at: 1_000 })

  assert.ok(s.indexFile.startsWith(CACHE))
  assert.ok(s.codeFile("u1").startsWith(CACHE))
  assert.deepEqual(readdirSync(sandbox), [".cache"])
})

// ═══════════════════════════════════════════════════════════════════
// 9. 首选账号解析（纯函数，不读磁盘）
// ═══════════════════════════════════════════════════════════════════

test("preferredHome：first:true → 最小正 order → 第一行，只看本 provider 且有 home 的行", () => {
  const rows = [
    { agent: "plugin:other", home: "other#1", first: true, order: 1 },
    { agent: "plugin:phanthycode", home: "phanthycode#2", order: 2 },
    { agent: "plugin:phanthycode", home: "   ", order: 0 },
    { agent: "plugin:phanthycode", home: "phanthycode#3", first: true, order: 3 },
  ]
  assert.equal(preferredHome(rows, "phanthycode"), "phanthycode#3")

  // 没有 first → 最小正 order
  const noFirst = rows.map(({ first, ...row }) => row)
  assert.equal(preferredHome(noFirst, "phanthycode"), "phanthycode#2")

  // order 0 / 负数 / 缺失都不算「正 order」→ 退回第一行
  const flat = [
    { agent: "plugin:phanthycode", home: "h0", order: 0 },
    { agent: "plugin:phanthycode", home: "h1", order: -1 },
    { agent: "plugin:phanthycode", home: "h2" },
  ]
  assert.equal(preferredHome(flat, "phanthycode"), "h0")

  // 读不到 / 空表 / 别的 provider → 空串（首选未知，调用方回退手工码）
  assert.equal(preferredHome([], "phanthycode"), "")
  assert.equal(preferredHome(null, "phanthycode"), "")
  assert.equal(preferredHome(rows, "nope"), "")
  assert.equal(preferredHome(rows, ""), "")
})

test("preferredHome 的返回值可以直接喂给 resolve（home 只是入口，键仍是 uid）", () => {
  const rows = [
    { agent: "plugin:phanthycode", home: "phanthycode#1", order: 1, first: true },
    { agent: "plugin:phanthycode", home: "phanthycode#2", order: 2 },
  ]
  assert.equal(preferredHome(rows, "phanthycode"), "phanthycode#1")

  const s = createInviteSourceStore("zzsrc-home-to-uid")
  s.noteAccount({ uid: "uid-from-home", accountScope: "scope-1", accountId: "首选", at: 1_000 })
  s.saveCode({ uid: "uid-from-home", code: CODE_A, at: 1_000 })
  const v = s.resolve({ preferFirst: true, preferredUid: "uid-from-home" })
  assert.equal(v.kind, "preferred")
  assert.equal(v.code, CODE_A)
})
