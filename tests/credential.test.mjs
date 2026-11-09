import test from "node:test"
import assert from "node:assert/strict"

import {
  rawCredentialOf,
  fingerprint,
  metadataOf,
  credentialKindOf,
  uidOf,
  metadataWithIdentity,
  accountScopeOf,
} from "../src/credential.mjs"

test("rawCredentialOf 逐候选 trim，按 access → key → token 选首个非空值", () => {
  assert.equal(rawCredentialOf({ access: "  access-token  ", key: "key-token", token: "fallback" }), "access-token")
  assert.equal(rawCredentialOf({ access: "", key: " key-token ", token: "fallback" }), "key-token")
  assert.equal(rawCredentialOf({ access: " \t\n", key: " key-token ", token: "fallback" }), "key-token")
  assert.equal(rawCredentialOf({ access: "  ", key: "\r\n", token: " fallback " }), "fallback")
  assert.equal(rawCredentialOf({ token: " fallback " }), "fallback")
  assert.equal(rawCredentialOf({ access: " ", refresh: " refresh-only " }), "", "refresh 不能冒充访问凭据")
  assert.equal(rawCredentialOf({ key: 123 }), "123")
})

test("rawCredentialOf 对缺失 auth 或凭据返回空串", () => {
  assert.equal(rawCredentialOf(), "")
  assert.equal(rawCredentialOf(null), "")
  assert.equal(rawCredentialOf({ access: null, key: "", token: 0 }), "")
})

test("fingerprint 返回稳定的 12 位摘要，不泄漏原始 token", () => {
  const raw = "secret-token-that-must-not-leak"
  const value = fingerprint(raw)
  assert.match(value, /^[0-9a-f]{12}$/)
  assert.equal(value, fingerprint(raw))
  assert.notEqual(value, fingerprint("another-secret-token"))
  assert.equal(value.includes(raw), false)
  assert.equal(fingerprint(""), "e3b0c44298fc")
})

test("metadataOf 保留对象 metadata，对无效值返回新空对象", () => {
  const metadata = { kind: "cookie", userId: "user-1" }
  assert.equal(metadataOf({ metadata }), metadata)
  assert.deepEqual(metadataOf(), {})
  assert.deepEqual(metadataOf({ metadata: null }), {})
  assert.deepEqual(metadataOf({ metadata: "kind=cookie" }), {})
  assert.notEqual(metadataOf(), metadataOf())
})

test("credentialKindOf 优先 cached.kind，且不再调用 shape detector", () => {
  let calls = 0
  const detector = () => {
    calls += 1
    return "shape"
  }
  const auth = { access: "raw", metadata: { kind: "metadata" } }
  assert.equal(credentialKindOf(auth, { kind: "cached" }, detector), "cached")
  assert.equal(calls, 0)
})

test("credentialKindOf 其次使用 metadata.kind，仍不调用 shape detector", () => {
  let calls = 0
  const detector = () => {
    calls += 1
    return "shape"
  }
  assert.equal(credentialKindOf({ metadata: { kind: "metadata" } }, null, detector), "metadata")
  assert.equal(calls, 0)
})

test("credentialKindOf 最后调用厂商 shape detector，并兼容两种返回形状", () => {
  const seen = []
  assert.equal(credentialKindOf({ access: " raw " }, null, (raw) => {
    seen.push(raw)
    return "key"
  }), "key")
  assert.equal(credentialKindOf({ access: "raw" }, {}, () => ({ kind: "cookie", shape: {} })), "cookie")
  assert.deepEqual(seen, ["raw"])
})

test("credentialKindOf 对无探测器或空探测结果返回 unknown", () => {
  assert.equal(credentialKindOf({ access: "raw" }), "unknown")
  assert.equal(credentialKindOf({ access: "raw" }, null, () => "unknown"), "unknown")
  assert.equal(credentialKindOf({ access: "raw" }, null, () => ({ kind: "" })), "unknown")
  assert.equal(credentialKindOf({ access: "raw" }, null, () => null), "unknown")
})

test("uidOf 按 record.userId → metadata.userId → auth.uid 选择身份", () => {
  const auth = {
    access: "raw-token",
    uid: "auth-uid",
    metadata: { userId: "metadata-user" },
  }
  assert.equal(uidOf(auth, { userId: "record-user" }), "record-user")
  assert.equal(uidOf(auth), "metadata-user")
  assert.equal(uidOf({ access: "raw-token", uid: "auth-uid", metadata: {} }), "auth-uid")
})

test("uidOf 回退到凭据指纹，空白高优先级凭据不会遮蔽有效回退", () => {
  const raw = "super-secret-raw-token"
  const uid = uidOf({ access: raw })
  assert.equal(uid, fingerprint(raw))
  assert.match(uid, /^[0-9a-f]{12}$/)
  assert.equal(uid.includes(raw), false)
  assert.equal(uidOf({ access: " \t\n", key: " key-token " }), fingerprint("key-token"))
  assert.equal(uidOf({ access: "  ", key: "\r\n", token: " fallback " }), fingerprint("fallback"))
  assert.equal(uidOf({}), "")
  assert.equal(uidOf(), "")
})

test("uidOf 支持 refresh-only，并优先用更稳定的 refresh 指纹", () => {
  assert.equal(uidOf({ type: "oauth", refresh: " refresh-only " }), fingerprint("refresh-only"))
  assert.equal(
    uidOf({ type: "oauth", access: "rotating-access", refresh: "stable-refresh" }),
    fingerprint("stable-refresh"),
  )
})

test("metadataWithIdentity：稳定身份只写 metadata，且是合并而不是替换", () => {
  const auth = { metadata: { email: "旧名字", userId: "old-uid", accountScope: "old-scope", kind: "api" } }

  const merged = metadataWithIdentity(auth, { accountId: "新名字", uid: "new-uid", accountScope: "new-scope" })
  assert.deepEqual(merged, { email: "新名字", userId: "new-uid", accountScope: "new-scope", kind: "api" })

  // 只给一部分值（refresh 补名字）时，其余稳定身份必须保留
  const kept = metadataWithIdentity(auth, { accountId: "新名字" })
  assert.equal(kept.userId, "old-uid")
  assert.equal(kept.accountScope, "old-scope")
  assert.equal(kept.kind, "api")

  // 登录（没有旧登录态）+ 全空 → 空对象（不能写 undefined / 空串）
  assert.deepEqual(metadataWithIdentity(undefined, {}), {})
  assert.deepEqual(metadataWithIdentity(undefined, { accountId: "  ", uid: "", accountScope: " " }), {})

  // 不改入参
  assert.equal(auth.metadata.email, "旧名字")
  assert.equal(auth.metadata.userId, "old-uid")
})

test("accountScopeOf：顶层 → metadata → 安装记录，拿不到就是空串（不拿名字冒充）", () => {
  assert.equal(accountScopeOf({ accountScope: "top" }, { accountScope: "rec" }), "top")
  assert.equal(accountScopeOf({ metadata: { accountScope: "meta" } }, { accountScope: "rec" }), "meta")
  assert.equal(accountScopeOf({}, { accountScope: "rec" }), "rec")
  assert.equal(accountScopeOf({}, null), "")
  assert.equal(accountScopeOf({ accountScope: "   ", metadata: { accountScope: " " } }, { accountScope: "" }), "")
  // 显示名 / uid 不是作用域
  assert.equal(accountScopeOf({ accountId: "名字", uid: "uid" }, { accountId: "名字" }), "")
})
