// tests/registration.test.mjs —— 注册请求构造 + 契约（离线，全部虚构值）
//
// 2026-11-09 真机实测后，三项「静态不可判定」全部定案，这里把它们锁成断言：
//   ① device_public_key 必须与 public_key 不同（三把独立密钥）；
//   ② body.device_signature 用 **device 私钥**签；
//   ③ 请求头 x-desktop-signature 用 **identity 私钥**签。
// 另外锁住字段顺序、两条 canonical、幂等键格式，以及 body.version 是**官方客户端版本号**。

import test from "node:test"
import assert from "node:assert/strict"

import {
  DeviceContractPending,
  accountScopeFromProfile,
  EDITION,
  PLUGIN_VERSION,
  REGISTER_PATH,
  buildRegistrationRequest,
  idempotencyKeyFor,
  normalizePolicy,
  platformName,
  registrationBody,
} from "../src/registration.mjs"
import {
  generateEd25519KeyPair,
  importPublicKey,
  sha256B64Url,
  v1Canonical,
  verifyCanonical,
} from "../src/proof.mjs"
import { installationIdFromPublicKey } from "../src/installation-id.mjs"

const TS = 1_767_225_600_000
const NONCE = "NONCE24_B64URL_TEST_0000000000"

function fakeRecord() {
  const identity = generateEd25519KeyPair()
  const device = generateEd25519KeyPair()
  const inference = generateEd25519KeyPair()
  return {
    schemaVersion: 1,
    account: "acct_test",
    installationId: installationIdFromPublicKey(identity.publicKeyB64Url),
    publicKey: identity.publicKeyB64Url,
    privateKey: identity.privateKeyB64Url,
    devicePublicKey: device.publicKeyB64Url,
    devicePrivateKey: device.privateKeyB64Url,
    inferencePublicKey: inference.publicKeyB64Url,
    inferencePrivateKey: inference.privateKeyB64Url,
    accountScope: "acct_test",
    inferenceToken: "",
    registeredAt: 0,
  }
}

/** 生产契约（见 src/production-auth.mjs 的 IDENTITY_POLICY） */
const IDENTITY_POLICY = { bindingSigner: "device", headerSigner: "identity", deviceKeyDistinct: true }
/** 历史契约：device 与 identity 同钥。只为兼容旧探针，生产不再使用 */
const LEGACY_POLICY = { bindingSigner: "identity", headerSigner: "identity", deviceKeyDistinct: false }

test("契约缺失 → DeviceContractPending，并列出三项待确认", () => {
  for (const policy of [undefined, {}, { bindingSigner: "identity" }]) {
    assert.throws(
      () => normalizePolicy(policy),
      (error) => {
        assert.ok(error instanceof DeviceContractPending)
        assert.equal(error.code, "device_contract_pending")
        assert.ok(error.gaps.length >= 1)
        return true
      },
    )
  }
  assert.throws(() => normalizePolicy({ bindingSigner: "nobody", headerSigner: "identity", deviceKeyDistinct: true }), DeviceContractPending)
  assert.throws(() => normalizePolicy({ bindingSigner: "device", headerSigner: "identity", deviceKeyDistinct: "no" }), DeviceContractPending)
})

test("accountScope 只认 profile 的 account.uuid，缺失即报错、不回退", () => {
  assert.equal(accountScopeFromProfile({ account: { uuid: "8f14e45f-ceea-467a-9c1f-2b3d4e5f6a7b" } }), "8f14e45f-ceea-467a-9c1f-2b3d4e5f6a7b")
  for (const body of [{}, { account: {} }, { account: { uuid: "" } }, { account: { uuid: 42 } }, null, { sub: "jwt-sub" }]) {
    assert.throws(
      () => accountScopeFromProfile(body),
      (error) => error.code === "internal_error" && error.reason === "account_scope_missing" && /account\.uuid/.test(error.message),
      `必须拒绝：${JSON.stringify(body)}`,
    )
  }
})

test("契约齐全时归一成固定形状（不引入额外默认值）", () => {
  assert.deepEqual(normalizePolicy(IDENTITY_POLICY), IDENTITY_POLICY)
})

test("请求体字段顺序与官方客户端注入顺序一致", () => {
  const body = registrationBody({
    publicKey: "PUBKEY",
    devicePublicKey: "DEVKEY",
    deviceSignature: "SIG",
    inferencePublicKey: "INFER",
  })
  assert.deepEqual(Object.keys(body), [
    "public_key",
    "edition",
    "platform",
    "version",
    "device_public_key",
    "device_signature",
    "inference_public_key",
  ])
  assert.equal(body.edition, EDITION)
  assert.equal(body.edition, "phanthy_work")
})

test("body.version 是**官方客户端**版本号 2.48.0（不是插件版本）", () => {
  assert.equal(PLUGIN_VERSION, "2.48.0")
  assert.equal(registrationBody({ publicKey: "P", devicePublicKey: "D", deviceSignature: "S", inferencePublicKey: "I" }).version, "2.48.0")
  // 插件自己的版本在 package.json，两者互不代表；这里只防「有人把它改回 0.1.0」
  assert.notEqual(PLUGIN_VERSION, "0.1.0")
})

test("platform 映射三档", () => {
  assert.equal(platformName("win32"), "windows")
  assert.equal(platformName("darwin"), "macos")
  assert.equal(platformName("linux"), "linux")
})

test("幂等键是 register:<installationId>，空值抛错", () => {
  assert.equal(idempotencyKeyFor("inst_0001"), "register:inst_0001")
  assert.throws(() => idempotencyKeyFor(""), TypeError)
})

test("构造注册请求：三把独立密钥、device 与 v1 各签一次、两条 canonical 用 LF", () => {
  const record = fakeRecord()
  const request = buildRegistrationRequest({
    record,
    policy: IDENTITY_POLICY,
    sessionKeyPublicKey: record.inferencePublicKey,
    accessToken: "access-test",
    now: () => TS,
    nonce: NONCE,
  })

  // device canonical：7 段，第 4 段是 identity 的 public_key，第 5 段是 inference 会话公钥
  const deviceParts = request.canonical.device.split("\n")
  assert.equal(deviceParts.length, 7)
  assert.equal(deviceParts[0], "desktop-device-v1")
  assert.equal(deviceParts[1], "acct_test")
  assert.equal(deviceParts[2], record.installationId)
  assert.equal(deviceParts[3], record.publicKey)
  assert.equal(deviceParts[4], record.inferencePublicKey)

  // v1 canonical 覆盖的是**最终 body 字符串**
  assert.equal(request.canonical.header.split("\n")[1], "POST")
  assert.equal(request.canonical.header.split("\n")[2], REGISTER_PATH)
  assert.equal(request.canonical.header.split("\n")[5], sha256B64Url(request.bodyString))
  assert.equal(request.canonical.header.split("\n")[6], `register:${record.installationId}`)

  // 三把密钥互不相同：device_public_key 是独立那把，不是 public_key 的复用
  assert.equal(request.body.device_public_key, record.devicePublicKey)
  assert.notEqual(request.body.device_public_key, record.publicKey)
  assert.notEqual(request.body.inference_public_key, record.publicKey)
  assert.notEqual(request.body.inference_public_key, record.devicePublicKey)
  assert.equal(request.body.inference_public_key, record.inferencePublicKey)
  assert.equal(request.body.device_signature, request.signature.device)

  // 签名者分工：device canonical 用 device，v1 头用 identity
  assert.deepEqual(request.signers, { device: "device", header: "identity" })

  // 头：Bearer + 安装 id + 时间戳 + nonce + 签名 + 幂等键
  const headers = request.headers
  assert.equal(headers.authorization, "Bearer access-test")
  assert.equal(headers["x-desktop-installation-id"], record.installationId)
  assert.equal(headers["x-desktop-timestamp"], String(TS))
  assert.equal(headers["x-desktop-nonce"], NONCE)
  assert.equal(headers["idempotency-key"], `register:${record.installationId}`)
  assert.equal(headers["x-desktop-signature"], request.signature.header)
})

test("两条签名各用各的私钥：device 签名能用 device 公钥验过、v1 头用 identity 公钥验过", () => {
  const record = fakeRecord()
  const request = buildRegistrationRequest({
    record,
    policy: IDENTITY_POLICY,
    sessionKeyPublicKey: record.inferencePublicKey,
    accessToken: "access-test",
    now: () => TS,
    nonce: NONCE,
  })

  const deviceKey = importPublicKey(record.devicePublicKey)
  const identityKey = importPublicKey(record.publicKey)

  assert.equal(verifyCanonical(deviceKey, request.canonical.device, request.signature.device), true)
  assert.equal(verifyCanonical(identityKey, request.canonical.header, request.signature.header), true)

  // 交叉验签必须失败 —— 否则「用哪把钥匙」这件事就没被锁住
  assert.equal(verifyCanonical(identityKey, request.canonical.device, request.signature.device), false)
  assert.equal(verifyCanonical(deviceKey, request.canonical.header, request.signature.header), false)

  // v1 串里的 body 摘要必须等于最终 body 的摘要（顺序错了这里会红）
  const expected = v1Canonical({
    method: "POST",
    upstreamPath: REGISTER_PATH,
    timestamp: String(TS),
    nonce: NONCE,
    body: request.bodyString,
    idempotencyKey: `register:${record.installationId}`,
  })
  assert.equal(expected, request.canonical.header)
})

test("历史契约（deviceKeyDistinct:false）仍可构造：device_public_key 复用 identity 公钥", () => {
  const record = fakeRecord()
  const request = buildRegistrationRequest({
    record,
    policy: LEGACY_POLICY,
    sessionKeyPublicKey: record.inferencePublicKey,
    accessToken: "access-test",
    now: () => TS,
    nonce: NONCE,
  })
  assert.equal(request.body.device_public_key, record.publicKey)
  assert.deepEqual(request.signers, { device: "identity", header: "identity" })
  assert.equal(verifyCanonical(importPublicKey(record.publicKey), request.canonical.device, request.signature.device), true)
})

test("缺 accountScope → 报缺口（作用域只能来自服务端）", () => {
  const record = { ...fakeRecord(), accountScope: "" }
  assert.throws(
    () =>
      buildRegistrationRequest({
        record,
        policy: IDENTITY_POLICY,
        sessionKeyPublicKey: record.inferencePublicKey,
        accessToken: "a",
      }),
    DeviceContractPending,
  )
})

test("记录缺 device 密钥 → 报缺口，不擅自复用 identity 公钥", () => {
  const record = { ...fakeRecord(), devicePublicKey: "", devicePrivateKey: "" }
  assert.throws(
    () =>
      buildRegistrationRequest({
        record,
        policy: IDENTITY_POLICY,
        sessionKeyPublicKey: record.inferencePublicKey,
        accessToken: "a",
      }),
    (error) => {
      assert.ok(error instanceof DeviceContractPending)
      assert.match(error.gaps.join(""), /device 密钥/)
      return true
    },
  )
})

test("缺 inference 会话公钥 → TypeError（body 字段不许空）", () => {
  const record = fakeRecord()
  assert.throws(
    () => buildRegistrationRequest({ record, policy: IDENTITY_POLICY, sessionKeyPublicKey: "", accessToken: "a" }),
    TypeError,
  )
})
