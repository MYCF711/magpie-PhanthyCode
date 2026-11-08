// tests/device-key.test.mjs —— 设备身份落盘（离线；HOME 重定向到临时目录，不碰真实用户目录）
//
// 这里锁的是「三把密钥」的存储契约（2026-11-09 真机实测）：
//   · identity / device / inference 互不相同，且都能从磁盘还原；
//   · installationId 只由 identity 公钥派生（di_ 前缀）；
//   · 0.2.3 的旧记录（只有 identity）就地补密钥，**identity 与 id 不变** ——
//     变了就等于换设备，服务端会当成另一台。

import test, { after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ⚠ 先重定向 HOME，再动态 import —— 静态 import 会被提升到环境变量设置之前
const home = mkdtempSync(join(tmpdir(), "pw-device-"))
process.env.USERPROFILE = home
process.env.HOME = home

const {
  clearInstallation,
  createInstallation,
  devicePrivateKey,
  ensureInstallation,
  hasDistinctKeys,
  identityPrivateKey,
  inferencePrivateKey,
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
