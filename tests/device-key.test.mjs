// tests/device-key.test.mjs —— 设备身份落盘（离线；HOME 重定向到临时目录，不碰真实用户目录）
//
// 这里锁的是「三把密钥」的存储契约（2026-11-09 真机实测）：
//   · identity / device / inference 互不相同，且都能从磁盘还原；
//   · installationId 只由 identity 公钥派生（di_ 前缀）；
//   · 0.2.3 的旧记录（只有 identity）就地补密钥，**identity 与 id 不变** ——
//     变了就等于换设备，服务端会当成另一台。

import test, { after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ⚠ 先重定向 HOME，再动态 import —— 静态 import 会被提升到环境变量设置之前
const home = mkdtempSync(join(tmpdir(), "pw-device-"))
process.env.USERPROFILE = home
process.env.HOME = home

const {
  adoptInstallationByScope,
  clearInstallation,
  createInstallation,
  devicePrivateKey,
  ensureInstallation,
  hasDistinctKeys,
  identityPrivateKey,
  inferencePrivateKey,
  findInstallationByScope,
  installationFile,
  matchesPrivateKey,
  publicKeyOfPrivate,
  readInstallation,
  renewInferenceKey,
  saveInstallation,
} = await import("../src/device-key.mjs")
const { installationIdFromPublicKey } = await import("../src/installation-id.mjs")

after(() => {
  rmSync(home, { recursive: true, force: true })
})

test("新建安装记录：三把 ed25519 密钥互不相同，id 由 identity 公钥派生", () => {
  const record = createInstallation({ account: "acct-test-1", now: () => 1_700_000_000_000 })
  assert.match(record.installationId, /^di_[A-Za-z0-9_-]{43}$/)
  assert.equal(record.installationId, installationIdFromPublicKey(record.publicKey), "id 只由 identity 公钥决定")
  assert.equal(record.installationIdSource, "public_key")
  assert.equal(record.schemaVersion, 1)

  assert.ok(record.publicKey.length > 40)
  assert.ok(record.privateKey.length > 40)
  assert.ok(record.devicePublicKey.length > 40)
  assert.ok(record.devicePrivateKey.length > 40)
  assert.ok(record.inferencePublicKey.length > 40)
  assert.ok(record.inferencePrivateKey.length > 40)
  assert.equal(hasDistinctKeys(record), true, "三把公钥必须互不相同")

  // 每把私钥都能还原成对应的公钥
  assert.equal(publicKeyOfPrivate(identityPrivateKey(record)), record.publicKey)
  assert.equal(publicKeyOfPrivate(devicePrivateKey(record)), record.devicePublicKey)
  assert.equal(publicKeyOfPrivate(inferencePrivateKey(record)), record.inferencePublicKey)

  assert.equal(record.accountScope, "", "作用域只能来自服务端，不猜")
  assert.equal(record.inferenceToken, "", "推理令牌只能是签出来的，不伪造")
})

test("落盘：写在 ~/.cache/magpie 下，文件名带账号；读回来是同一份", () => {
  const account = "acct-test-2"
  const { record, created } = ensureInstallation({ account })
  assert.equal(created, true)

  const file = installationFile(account)
  assert.ok(file.startsWith(join(home, ".cache", "magpie")), `落盘位置应在 cache 目录：${file}`)
  assert.ok(existsSync(file))

  const raw = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(raw.installationId, record.installationId)
  assert.equal(raw.publicKey, record.publicKey)
  assert.equal(raw.devicePublicKey, record.devicePublicKey)
  assert.equal(raw.inferencePublicKey, record.inferencePublicKey)

  const again = ensureInstallation({ account })
  assert.equal(again.created, false, "第二次不能重新生成（否则每次登录都换设备）")
  assert.equal(again.record.installationId, record.installationId)
})

test("旧记录（0.2.3 只有 identity）就地补 device/inference 密钥，identity 与 id 不变", () => {
  const account = "acct-test-legacy"
  const fresh = createInstallation({ account })
  // 模拟 0.2.3 的记录：只有 identity 那一对 + 旧的 scope 哈希 id
  const legacy = {
    schemaVersion: 1,
    account,
    installationId: "di_legacyScopeHashNotMatchingPublicKey0000000000",
    installationIdSource: "account_scope",
    publicKey: fresh.publicKey,
    privateKey: fresh.privateKey,
    accountScope: "scope-legacy",
    devicePublicKey: "",
    devicePrivateKey: "",
    inferencePublicKey: "",
    inferencePrivateKey: "",
    inferenceToken: "",
    registeredAt: 0,
  }
  saveInstallation(account, legacy)

  const { record, created } = ensureInstallation({ account })
  assert.equal(created, false, "旧记录不能被当成新记录")
  assert.equal(record.publicKey, fresh.publicKey, "identity 公钥不许换")
  assert.equal(record.privateKey, fresh.privateKey)
  assert.equal(record.installationId, installationIdFromPublicKey(fresh.publicKey), "旧 id 在这里被纠正")
  assert.equal(record.installationIdSource, "public_key")
  assert.ok(record.devicePublicKey && record.devicePrivateKey, "device 密钥必须补齐")
  assert.ok(record.inferencePublicKey && record.inferencePrivateKey, "inference 密钥必须补齐")
  assert.equal(record.accountScope, "scope-legacy", "已取到的 accountScope 保留")
  assert.equal(hasDistinctKeys(record), true)

  const onDisk = readInstallation(account)
  assert.equal(onDisk.devicePublicKey, record.devicePublicKey, "补完必须落盘（不能每次读都重算）")
})

test("renewInferenceKey 只换 inference 那一对（identity / device 不动）", () => {
  const account = "acct-test-renew"
  const { record } = ensureInstallation({ account })
  const next = renewInferenceKey(account, record, { now: () => 1_700_000_000_001 })
  assert.notEqual(next.inferencePublicKey, record.inferencePublicKey)
  assert.notEqual(next.inferencePrivateKey, record.inferencePrivateKey)
  assert.equal(next.publicKey, record.publicKey)
  assert.equal(next.devicePublicKey, record.devicePublicKey)
  assert.equal(publicKeyOfPrivate(inferencePrivateKey(next)), next.inferencePublicKey)
})

test("公私钥自洽：matchesPrivateKey 为真；公钥被改过就为假", () => {
  const account = "acct-test-3"
  const { record } = ensureInstallation({ account })
  assert.equal(matchesPrivateKey(record), true)

  const tampered = { ...record, publicKey: createInstallation({ account: "other" }).publicKey }
  assert.equal(matchesPrivateKey(tampered), false)
  assert.notEqual(publicKeyOfPrivate(identityPrivateKey(record)), tampered.publicKey)
})

test("缓存可删：删掉安装记录后读回 null，再 ensure 会重建", () => {
  const account = "acct-test-4"
  const first = ensureInstallation({ account }).record
  assert.equal(clearInstallation(account), true)
  assert.equal(readInstallation(account), null)

  const second = ensureInstallation({ account }).record
  assert.notEqual(second.installationId, first.installationId)
})

test("缺密钥的还原函数直接抛（不返回 undefined 让签名变成空串）", () => {
  assert.throws(() => devicePrivateKey({}), /device 私钥/)
  assert.throws(() => inferencePrivateKey({}), /inference 私钥/)
})

test("坏文件 / 版本不符都当「没有记录」，不抛", () => {
  const account = "acct-test-5"
  // saveInstallation 会把版本号归一到当前版本，所以这里直接写文件模拟「旧版本缓存」
  saveInstallation(account, createInstallation({ account }))
  const file = installationFile(account)
  writeFileSync(file, JSON.stringify({ schemaVersion: 99, installationId: "x", publicKey: "p", privateKey: "k" }), "utf8")
  assert.equal(readInstallation(account), null)

  writeFileSync(file, "{not json", "utf8")
  assert.equal(readInstallation(account), null)
})

test("adoptInstallationByScope：已注册记录迁到稳定键，identity / installationId 一个字节都不动", () => {
  const oldKey = "acct-adopt-old-token"
  const stableKey = "acct-adopt-stable"
  clearInstallation(oldKey)
  clearInstallation(stableKey)

  const legacy = createInstallation({ account: oldKey })
  saveInstallation(oldKey, { ...legacy, accountScope: "scope-adopt", registeredAt: 1_700_000_000_000 })

  const adopted = adoptInstallationByScope(stableKey, "scope-adopt")
  assert.equal(adopted.installationId, legacy.installationId, "换键不许换设备")
  assert.equal(adopted.publicKey, legacy.publicKey)
  assert.equal(adopted.privateKey, legacy.privateKey)
  assert.equal(adopted.devicePublicKey, legacy.devicePublicKey)
  assert.equal(adopted.account, stableKey, "记录里的账号键也要更新")

  assert.equal(readInstallation(oldKey), null, "旧键记录清掉（否则磁盘上留孤儿）")
  assert.equal(readInstallation(stableKey).installationId, legacy.installationId)

  // 幂等：再找一次还是同一条，不产生新记录
  const again = adoptInstallationByScope(stableKey, "scope-adopt")
  assert.equal(again.installationId, legacy.installationId)
  assert.equal(findInstallationByScope("scope-adopt").publicKey, legacy.publicKey)

  clearInstallation(stableKey)
})

test("adoptInstallationByScope：不同作用域 / 未注册 / 空参数一律不复用（同名账号不串）", () => {
  const a = createInstallation({ account: "acct-scope-a" })
  saveInstallation("acct-scope-a", { ...a, accountScope: "scope-a", registeredAt: 1 })
  const b = createInstallation({ account: "acct-scope-b" })
  saveInstallation("acct-scope-b", { ...b, accountScope: "scope-b", registeredAt: 1 })

  const adoptedB = adoptInstallationByScope("acct-scope-b2", "scope-b")
  assert.equal(adoptedB.publicKey, b.publicKey, "只搬自己作用域那一条")
  assert.equal(findInstallationByScope("scope-a").publicKey, a.publicKey, "A 的记录必须还在原处")
  assert.equal(readInstallation("acct-scope-b"), null, "B 的旧键清掉")

  // 未注册的半条记录不值得复用（identity 还没被服务端接受过）
  const pending = createInstallation({ account: "acct-scope-pending" })
  saveInstallation("acct-scope-pending", { ...pending, accountScope: "scope-pending" })
  assert.equal(adoptInstallationByScope("acct-scope-pending-2", "scope-pending"), null)
  assert.equal(readInstallation("acct-scope-pending")?.installationId, pending.installationId, "未注册记录不动")

  // 409 熔断记录也要能跨键传播（账号级终态，换键不能绕过退避）
  const blocked = createInstallation({ account: "acct-scope-blocked" })
  saveInstallation("acct-scope-blocked", {
    ...blocked,
    accountScope: "scope-blocked",
    registrationUnavailableAt: 1_700_000_000_000,
  })
  const adoptedBlocked = adoptInstallationByScope("acct-scope-blocked-2", "scope-blocked")
  assert.ok(adoptedBlocked, "熔断记录也要找回来")
  assert.equal(adoptedBlocked.registrationUnavailableAt, 1_700_000_000_000)
  assert.equal(readInstallation("acct-scope-blocked"), null)

  assert.equal(adoptInstallationByScope("", "scope-a"), null)
  assert.equal(adoptInstallationByScope("acct-x", ""), null)
  assert.equal(adoptInstallationByScope("acct-x", "unknown-scope"), null)
  assert.equal(readInstallation("acct-x"), null, "找不到就不许留下空记录")
})

// ── M-1：0.2.3 的「只有 identity 且已注册」记录，迁移时必须规范化 ──────────
//
// 旧记录只有 identity 那一对（device / inference 是后来才拆出来的）。adopt 原样搬走
// 之后 `registeredAt` 又有值 ⇒ 注册被跳过、inference 却空着 ⇒ 第一次
// `requestInferenceToken` 直接 409（假错误，第二次才自愈）。
// 判据：**迁移返回前**就补齐 device / inference（identity 与已注册事实不动），
// 这样第一次调用就能换到令牌，既不用重新注册、也不需要「第二次才成功」。

test("adoptInstallationByScope：只有 identity 的已注册旧记录，迁移后三把密钥齐全（M-1）", () => {
  // ① 真实的 0.2.3 形状：id 是 **accountScope 哈希**，不是公钥派生值
  const oldKey = "acct-legacy-identity-only"
  const stableKey = "acct-legacy-identity-only-stable"
  clearInstallation(oldKey)
  clearInstallation(stableKey)
  const fresh = createInstallation({ account: oldKey })
  const legacy = {
    schemaVersion: 1,
    account: oldKey,
    installationId: "di_legacyScopeHash000000000000000000000000",
    installationIdSource: "account_scope",
    publicKey: fresh.publicKey,
    privateKey: fresh.privateKey,
    accountScope: "scope-legacy-identity-only",
    devicePublicKey: "",
    devicePrivateKey: "",
    inferencePublicKey: "",
    inferencePrivateKey: "",
    inferenceToken: "",
    registeredAt: 1_700_000_000_000,
  }
  saveInstallation(oldKey, legacy)

  const adopted = adoptInstallationByScope(stableKey, "scope-legacy-identity-only")
  assert.ok(adopted, "已注册的旧记录必须被找回（否则等于重新注册一台设备）")
  // identity 那一对逐字节不动
  assert.equal(adopted.publicKey, legacy.publicKey, "identity 公钥不许换")
  assert.equal(adopted.privateKey, legacy.privateKey, "identity 私钥不许换")
  assert.equal(adopted.account, stableKey, "记录里的账号键也要更新")
  assert.equal(adopted.registeredAt, legacy.registeredAt, "已注册事实必须保留（否则会再注册一次）")
  // device / inference 必须**在迁移返回前**补齐
  assert.ok(adopted.devicePublicKey && adopted.devicePrivateKey, "device 密钥必须在迁移时补齐")
  assert.ok(adopted.inferencePublicKey && adopted.inferencePrivateKey, "inference 密钥必须在迁移时补齐")
  assert.equal(hasDistinctKeys(adopted), true, "三把公钥必须互不相同")
  // id 必须与 identity 公钥同源：scope 哈希 id 拿出去签名就是服务端 409
  assert.equal(adopted.installationId, installationIdFromPublicKey(legacy.publicKey))
  assert.equal(adopted.installationIdSource, "public_key")
  // 补齐后的记录必须**立刻落盘**（下一次请求从磁盘读，不是从内存）
  const onDisk = readInstallation(stableKey)
  assert.equal(onDisk.devicePublicKey, adopted.devicePublicKey)
  assert.equal(onDisk.inferencePublicKey, adopted.inferencePublicKey)
  assert.equal(readInstallation(oldKey), null, "写成功才删旧文件")

  // ② id 本来就是公钥派生值的那种旧记录：逐字节保持
  const oldKey2 = "acct-legacy-derived-id"
  const stableKey2 = "acct-legacy-derived-id-stable"
  clearInstallation(oldKey2)
  clearInstallation(stableKey2)
  const derived = createInstallation({ account: oldKey2 })
  saveInstallation(oldKey2, {
    ...derived,
    devicePublicKey: "",
    devicePrivateKey: "",
    inferencePublicKey: "",
    inferencePrivateKey: "",
    accountScope: "scope-derived-id",
    registeredAt: 1_700_000_000_001,
  })
  const adopted2 = adoptInstallationByScope(stableKey2, "scope-derived-id")
  assert.equal(adopted2.installationId, derived.installationId, "id 已经是派生值时一个字节都不动")
  assert.equal(adopted2.publicKey, derived.publicKey)
  assert.ok(adopted2.devicePublicKey && adopted2.inferencePublicKey, "同样要补齐密钥")

  clearInstallation(stableKey)
  clearInstallation(stableKey2)
})

test("adoptInstallationByScope：同键早退也要先规范化并落盘（F-E）", () => {
  const key = "acct-same-key-normalize"
  const scope = "scope-same-key-normalize"
  clearInstallation(key)
  const fresh = createInstallation({ account: key })
  saveInstallation(key, {
    ...fresh,
    accountScope: scope,
    devicePublicKey: "",
    devicePrivateKey: "",
    inferencePublicKey: "",
    inferencePrivateKey: "",
    registeredAt: 1_700_000_000_002,
  })

  const adopted = adoptInstallationByScope(key, scope)
  assert.equal(adopted.account, key)
  assert.equal(adopted.registeredAt, 1_700_000_000_002)
  assert.ok(adopted.devicePublicKey && adopted.devicePrivateKey, "同键也不能原样返回缺 device 的记录")
  assert.ok(adopted.inferencePublicKey && adopted.inferencePrivateKey, "同键也不能原样返回缺 inference 的记录")
  const onDisk = readInstallation(key)
  assert.equal(onDisk.devicePublicKey, adopted.devicePublicKey)
  assert.equal(onDisk.inferencePublicKey, adopted.inferencePublicKey)
  clearInstallation(key)
})

// ── L-3：写失败不能假成功，迁移更不能因此删掉源文件 ─────────────────────
//
// `writeJson` 失败只返回 `false`（磁盘满 / 权限 / 路径不可写 / 序列化失败），
// 旧实现把它丢掉，于是 `saveInstallation` 在什么都没写进去的情况下报「成功」，
// 而 adopt 再拿 `readJson(target)` 当判据 —— 目标键**原本就有旧文件**时，
// 它会先删掉源文件、再返回一条根本没落盘的记录。

test("saveInstallation：写不进去必须抛带 status/code 的错误，不能假成功（L-3）", () => {
  const account = "acct-write-fail"
  clearInstallation(account)
  const file = installationFile(account)
  // BigInt 不能 JSON 序列化 —— 与「磁盘满 / 权限」走同一条 writeJson 失败分支，且完全离线
  assert.throws(
    () => saveInstallation(account, { ...createInstallation({ account }), broken: 1n }),
    (error) => {
      assert.equal(error?.name, "ApiError", "必须是带 status/code 的明确错误（宿主与卡片才能分流）")
      assert.equal(error?.status, 502)
      assert.equal(error?.code, "internal_error")
      assert.match(error.message, /安装记录/)
      return true
    },
  )
  assert.equal(existsSync(file), false, "写失败不许留下半条记录")
})

test("adoptInstallationByScope：新记录写不进去时不许删旧文件（L-3）", () => {
  const oldKey = "acct-adopt-writefail-src"
  const stableKey = "acct-adopt-writefail-dst"
  clearInstallation(oldKey)
  clearInstallation(stableKey)
  const legacy = createInstallation({ account: oldKey })
  saveInstallation(oldKey, { ...legacy, accountScope: "scope-adopt-writefail", registeredAt: 1_700_000_000_000 })

  // 让目标写入失败：目标路径先被一个目录占住（rename 到目录上必失败）。
  // 这条失败与「磁盘满 / 权限不足」走同一个 writeJson 分支，且完全离线。
  mkdirSync(installationFile(stableKey))
  assert.throws(
    () => adoptInstallationByScope(stableKey, "scope-adopt-writefail"),
    (error) => error?.status === 502 && error?.code === "internal_error",
  )

  // 写失败时旧记录必须还在 —— 删掉源文件等于把设备身份弄丢，下次会重新注册一台
  const source = readInstallation(oldKey)
  assert.ok(source, "写失败时源记录必须保留")
  assert.equal(source.installationId, legacy.installationId)
  assert.equal(source.publicKey, legacy.publicKey)
  assert.equal(source.registeredAt, 1_700_000_000_000)

  rmSync(installationFile(stableKey), { recursive: true, force: true })
  clearInstallation(oldKey)
})
