// tests/installation-id.test.mjs —— installationId 派生规则（离线，不联网）
//
// 锁四件事：
//   ① 官方算法 `di_ + base64url(sha256(SPKI_DER[12:]))` 用**真机抓包值**钉死；
//   ② 只接受 ed25519 的 SPKI（长度/头不对就炸，不拿偏移量哈希出一个没人认得的 id）；
//   ③ 与 accountScope 无关 —— 旧的 scope 公式保留但已 deprecated，产出必须不同；
//   ④ 规则表里官方那条能反查命中（带不带 di_ 前缀都算同一条）。

import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  ED25519_SPKI_HEADER,
  INSTALLATION_ID_PREFIX,
  InstallationIdRuleUnknown,
  NAMESPACES,
  OFFICIAL_RULE,
  PUBLIC_KEY_RULE,
  RULES,
  SCOPE_RULE,
  candidatesFor,
  deriveInstallationId,
  installationIdFromPublicKey,
  installationIdFromScope,
  matchRule,
  rawEd25519PublicKey,
  stripPrefix,
  uuidV5,
  withPrefix,
} from "../src/installation-id.mjs"
import { generateEd25519KeyPair } from "../src/proof.mjs"

// ── 真机抓包值（2026-11-09，官方注册 200 的那条请求）──────────────────
const OFFICIAL_PUBLIC_KEY = "MCowBQYDK2VwAyEAW0H5wmGbfsy-5AL5jyN78WrmRw5J5pKUcopE29psQBA"
const OFFICIAL_INSTALLATION_ID = "di_CJN39yf0ubUxUOS5lPV9Cr0REAkE2D2F7H0Y0x7lnUk"
const OFFICIAL_RAW_KEY_HEX = "5b41f9c2619b7eccbee402f98f237bf16ae6470e49e69294728a44dbda6c4010"

test("官方算法黄金向量：di_ + base64url(sha256(裸 32 字节公钥))，与抓包逐字符一致", () => {
  assert.equal(installationIdFromPublicKey(OFFICIAL_PUBLIC_KEY), OFFICIAL_INSTALLATION_ID)

  // 手算复核：SPKI DER 44 字节，前 12 字节是固定头，哈希的是剩下 32 字节
  const der = Buffer.from(OFFICIAL_PUBLIC_KEY, "base64url")
  assert.equal(der.length, 44, "ed25519 SPKI/DER 是 44 字节")
  assert.equal(der.subarray(0, 12).toString("hex"), ED25519_SPKI_HEADER.toString("hex"))
  assert.equal(der.subarray(12).toString("hex"), OFFICIAL_RAW_KEY_HEX)
  assert.equal(createHash("sha256").update(der.subarray(12)).digest("base64url"), stripPrefix(OFFICIAL_INSTALLATION_ID))

  // 格式：di_ + 43 字符 base64url（共 46）
  assert.equal(INSTALLATION_ID_PREFIX, "di_")
  assert.equal(OFFICIAL_INSTALLATION_ID.length, 46)
  assert.match(OFFICIAL_INSTALLATION_ID, /^di_[A-Za-z0-9_-]{43}$/)

  // 反例：哈希整段 SPKI（44 字节）不是官方值 —— 早期「差一点」的写法在这里红
  const wholeSpki = createHash("sha256").update(der).digest("base64url")
  assert.notEqual(`di_${wholeSpki}`, OFFICIAL_INSTALLATION_ID)
})

test("rawEd25519PublicKey 只接受 ed25519 SPKI：长度/头不对一律抛 TypeError", () => {
  assert.equal(rawEd25519PublicKey(OFFICIAL_PUBLIC_KEY).toString("hex"), OFFICIAL_RAW_KEY_HEX)

  // 截断（32 字节裸公钥、没有头）
  const rawOnly = Buffer.from(OFFICIAL_RAW_KEY_HEX, "hex").toString("base64url")
  assert.throws(() => rawEd25519PublicKey(rawOnly), TypeError)

  // P-256 / RSA 的 SPKI 头不是这 12 个字节（保持 44 字节长度，才走到头检查）
  const wrongHeader = Buffer.concat([Buffer.from("30820122300d06092a864886f70d010101", "hex").subarray(0, 12), Buffer.alloc(32)])
  assert.equal(wrongHeader.length, 44)
  assert.throws(() => rawEd25519PublicKey(wrongHeader.toString("base64url")), /SPKI 头不是 ed25519/)

  for (const bad of ["", "   ", null, undefined, 42]) {
    assert.throws(() => rawEd25519PublicKey(bad), TypeError)
  }
})

test("前缀工具：withPrefix 幂等、stripPrefix 可逆", () => {
  assert.equal(withPrefix("abc"), "di_abc")
  assert.equal(withPrefix("di_abc"), "di_abc")
  assert.equal(stripPrefix("di_abc"), "abc")
  assert.equal(stripPrefix("abc"), "abc")
})

test("官方规则名可反查：RULES 里那条产出与 installationIdFromPublicKey 同源", () => {
  assert.equal(OFFICIAL_RULE, PUBLIC_KEY_RULE)
  assert.equal(OFFICIAL_RULE, "sha256(raw32(spki-der))-base64url")
  assert.equal(RULES[PUBLIC_KEY_RULE](OFFICIAL_PUBLIC_KEY), stripPrefix(OFFICIAL_INSTALLATION_ID))
  assert.equal(withPrefix(RULES[PUBLIC_KEY_RULE](OFFICIAL_PUBLIC_KEY)), OFFICIAL_INSTALLATION_ID)
})

test("已废弃的 scope 公式：还能跑，但产出与官方值不同（说明输入成分是错的）", () => {
  const SCOPE = "8f14e45f-ceea-467a-9c1f-2b3d4e5f6a7b"
  const legacy = installationIdFromScope(SCOPE)
  assert.equal(legacy, `di_${createHash("sha256").update(Buffer.from(SCOPE, "utf8")).digest("base64url")}`)
  assert.notEqual(legacy, installationIdFromPublicKey(OFFICIAL_PUBLIC_KEY))
  // 规则名还在表外（它是 scope 规则，不是公钥规则）
  assert.equal(SCOPE_RULE, "base64url(sha256(accountScope))")
  for (const bad of ["", "   ", null, undefined, 42]) {
    assert.throws(() => installationIdFromScope(bad), TypeError)
  }
})

test("派生是确定的，且与公钥绑定", () => {
  const a = generateEd25519KeyPair()
  const b = generateEd25519KeyPair()
  const first = installationIdFromPublicKey(a.publicKeyB64Url)
  assert.equal(first, installationIdFromPublicKey(a.publicKeyB64Url))
  assert.notEqual(first, installationIdFromPublicKey(b.publicKeyB64Url))
  assert.match(first, /^di_[A-Za-z0-9_-]{43}$/)
})

test("uuidV5 与 RFC 4122 公开向量一致", () => {
  assert.equal(uuidV5(NAMESPACES.dns, "python.org"), "886313e1-3b8a-5372-9b90-0c9aee199e5d")
  assert.throws(() => uuidV5("not-a-uuid", "x"), TypeError)
})

test("规则表非空；候选列表 11 条、带 di_ 前缀且确定", () => {
  assert.equal(Object.keys(RULES).length, 11)
  const pair = generateEd25519KeyPair()
  assert.deepEqual(candidatesFor(pair.publicKeyB64Url), candidatesFor(pair.publicKeyB64Url))
  const rows = candidatesFor(pair.publicKeyB64Url)
  assert.equal(rows.length, 11)
  for (const row of rows) assert.ok(row.id.startsWith(INSTALLATION_ID_PREFIX), `${row.rule} 必须带 di_ 前缀`)
})

test("未给规则 → InstallationIdRuleUnknown（绝不回退随机值）", () => {
  const pair = generateEd25519KeyPair()
  for (const rule of [undefined, "", "random-uuid", "verifyA-uuid"]) {
    assert.throws(
      () => deriveInstallationId(pair.publicKeyB64Url, rule),
      (error) => {
        assert.ok(error instanceof InstallationIdRuleUnknown)
        assert.equal(error.code, "internal_error")
        assert.equal(error.reason, "installation_id_rule_unknown")
        return true
      },
    )
  }
  assert.throws(() => deriveInstallationId("", PUBLIC_KEY_RULE), TypeError)
})

test("按官方规则派生：di_ 前缀 + 与公钥绑定", () => {
  const a = generateEd25519KeyPair()
  const b = generateEd25519KeyPair()
  const first = deriveInstallationId(a.publicKeyB64Url, PUBLIC_KEY_RULE)
  assert.equal(first, deriveInstallationId(a.publicKeyB64Url, PUBLIC_KEY_RULE))
  assert.notEqual(first, deriveInstallationId(b.publicKeyB64Url, PUBLIC_KEY_RULE))
  assert.equal(first, installationIdFromPublicKey(a.publicKeyB64Url))
})

test("uuid 形状的规则产出 di_ + 标准 UUID 文本（候选形态，不是结论）", () => {
  const pair = generateEd25519KeyPair()
  const id = deriveInstallationId(pair.publicKeyB64Url, "uuid-v4-shaped(sha256(spki-der))")
  assert.match(id, /^di_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

test("matchRule：带不带 di_ 前缀都命中同一条；未命中返回 null", () => {
  const pair = generateEd25519KeyPair()
  for (const row of candidatesFor(pair.publicKeyB64Url)) {
    assert.equal(matchRule(pair.publicKeyB64Url, row.id), row.rule)
    assert.equal(matchRule(pair.publicKeyB64Url, stripPrefix(row.id)), row.rule, "不带前缀也算同一条")
  }
  assert.equal(matchRule(pair.publicKeyB64Url, "di_00000000-0000-4000-8000-000000000000"), null)
  // 真机值反查命中的就是官方那条
  assert.equal(matchRule(OFFICIAL_PUBLIC_KEY, OFFICIAL_INSTALLATION_ID), PUBLIC_KEY_RULE)
})
