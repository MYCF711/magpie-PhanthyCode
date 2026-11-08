// tests/proof.test.mjs —— 三条 canonical + ed25519 签名（离线，不联网）
//
// 黄金值来自原始字节的复算（不看渲染，只看 hex）：
//   · `_up_\dist\assets\App-Y9eSJNhB.js` @101092 / @101391：device 与 v1 都是 LF；
//   · `claude-sidecar.exe` @99904271（`rw8` 里的 `desktop-inference-v2`）同样 LF。
// 三条 canonical 全部 LF 连接 —— 改了拼装顺序/分隔符，这组断言会立刻红。

import test from "node:test"
import assert from "node:assert/strict"

import {
  INFERENCE_PREFIX,
  LF,
  deviceCanonical,
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  inferenceCanonical,
  randomNonce,
  sha256B64Url,
  signCanonical,
  spkiB64Url,
  v1Canonical,
  verifyCanonical,
} from "../src/proof.mjs"
import { publicKeyOfPrivate } from "../src/device-key.mjs"

const TS = "1767225600000"
const NONCE = "NONCE24_B64URL_TEST_0000000000"
const BODY =
  '{"public_key":"PUBKEY_SPKI_B64URL_TEST","edition":"phanthy_work","platform":"windows","version":"2.48.0",' +
  '"device_public_key":"DEVKEY_SPKI_B64URL_TEST","device_signature":"SIGNATURE_B64URL_TEST",' +
  '"inference_public_key":"INFER_PUBKEY_SPKI_B64URL_TEST"}'

test("sha256 → base64url：空串与固定 body 都是固定值", () => {
  assert.equal(sha256B64Url(""), "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU")
  assert.equal(Buffer.byteLength(BODY), 249)
  assert.equal(sha256B64Url(BODY), "G2G-DNLsyHYCJuDCEQy3cYHaSlDCI4hjqUwXThfrdtU")
})

test("device canonical 用 LF 连接，7 段，sha 与原始字节复算一致", () => {
  const canonical = deviceCanonical({
    accountScope: "acct_test",
    installationId: "inst_0001",
    publicKey: "PUBKEY_SPKI_B64URL_TEST",
    sessionKeyPublicKey: "INFER_PUBKEY_SPKI_B64URL_TEST",
    timestamp: TS,
    nonce: NONCE,
  })
  assert.equal(canonical.split(LF).length, 7)
  assert.equal(canonical.split(LF)[0], "desktop-device-v1")
  assert.equal(canonical.includes(" "), false, "分隔符不是空格")
  assert.equal(sha256B64Url(canonical), "1u6Tv7izkvKgZX7LRx4abK6WU4YSHcrxak7EqQxX4yI")
})

test("v1 canonical 用 LF 连接，method 保持原值，sha 与原始字节复算一致", () => {
  const canonical = v1Canonical({
    method: "POST",
    upstreamPath: "/api/oauth/desktop-installations/register",
    timestamp: TS,
    nonce: NONCE,
    body: BODY,
    idempotencyKey: "register:inst_0001",
  })
  const parts = canonical.split(LF)
  assert.equal(parts.length, 7)
  assert.equal(parts[0], "v1")
  assert.equal(parts[1], "POST", "v1 串里 method 不转大写")
  assert.equal(parts[5], sha256B64Url(BODY))
  assert.equal(parts[6], "register:inst_0001")
  assert.equal(sha256B64Url(canonical), "OR08Bd8rkC28vNTmJWDwq9GBGrR8ooXm8eJd8QjM-SA")
})

test("v1 canonical：GET 没有 body 时用空串摘要", () => {
  const canonical = v1Canonical({
    method: "GET",
    upstreamPath: "/api/work/rewards",
    timestamp: TS,
    nonce: NONCE,
    idempotencyKey: "get:1",
  })
  assert.match(canonical, /47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU/)
})

test("inference canonical 用 LF 连接，12 段，METHOD 转大写，缺项保留分隔符", () => {
  const canonical = inferenceCanonical({
    method: "post",
    pathname: "/v1/messages",
    timestamp: TS,
    nonce: NONCE,
    body: '{"model":"x"}',
    authorization: "Bearer test-access-token",
    inferenceToken: "inference-token-test",
    requestId: "req_test_0001",
  })
  const parts = canonical.split(LF)
  assert.equal(parts.length, 12)
  assert.equal(parts[0], INFERENCE_PREFIX)
  assert.equal(parts[1], "POST")
  assert.equal(parts[2], "/v1/messages")
  // 后四段缺项写空串，但分隔符不能省
  assert.deepEqual(parts.slice(-4), ["req_test_0001", "", "", ""])
})

test("inference canonical：authorization 摘要覆盖完整的头值（含 Bearer 前缀）", () => {
  const base = {
    method: "POST",
    pathname: "/v1/messages",
    timestamp: TS,
    nonce: NONCE,
    body: "",
    inferenceToken: "t",
    requestId: "r",
  }
  const withPrefix = inferenceCanonical({ ...base, authorization: "Bearer abc" })
  const withoutPrefix = inferenceCanonical({ ...base, authorization: "abc" })
  assert.notEqual(withPrefix, withoutPrefix)
  assert.equal(withPrefix.split(LF)[6], sha256B64Url("Bearer abc"))
})

test("canonical 的必填段为空 → TypeError（空串会让服务端算出另一个串）", () => {
  assert.throws(() => deviceCanonical({ accountScope: "", installationId: "i", publicKey: "p", sessionKeyPublicKey: "s", timestamp: TS, nonce: NONCE }), TypeError)
  assert.throws(() => v1Canonical({ method: "", upstreamPath: "/x", timestamp: TS, nonce: NONCE, idempotencyKey: "k" }), TypeError)
  assert.throws(() => inferenceCanonical({ method: "POST", pathname: "", timestamp: TS, nonce: NONCE, authorization: "a", inferenceToken: "t", requestId: "r" }), TypeError)
})

test("ed25519：签发 → 验签往返；换一个字节就验不过", () => {
  const pair = generateEd25519KeyPair()
  const canonical = deviceCanonical({
    accountScope: "acct_test",
    installationId: "inst_0001",
    publicKey: pair.publicKeyB64Url,
    sessionKeyPublicKey: "INFER_PUBKEY",
    timestamp: TS,
    nonce: NONCE,
  })
  const signature = signCanonical(pair.privateKey, canonical)
  assert.equal(verifyCanonical(pair.publicKey, canonical, signature), true)
  assert.equal(verifyCanonical(pair.publicKey, `${canonical} `, signature), false)
  assert.equal(verifyCanonical(pair.publicKey, canonical, "AAAA"), false)
})

test("密钥编码：私钥往返、公钥 SPKI/base64url 自洽", () => {
  const pair = generateEd25519KeyPair()
  const restored = importPrivateKey(pair.privateKeyB64Url)
  assert.equal(publicKeyOfPrivate(restored), pair.publicKeyB64Url)
  assert.equal(spkiB64Url(importPublicKey(pair.publicKeyB64Url)), pair.publicKeyB64Url)

  const publicKey = importPublicKey(pair.publicKeyB64Url)
  const canonical = "desktop-device-v1\nacct\ninst\npub\nsess\n1\nn"
  const signature = signCanonical(restored, canonical)
  assert.equal(verifyCanonical(publicKey, canonical, signature), true)
})

test("nonce 是 base64url 且每次不同", () => {
  const a = randomNonce()
  const b = randomNonce()
  assert.match(a, /^[A-Za-z0-9_-]+$/)
  assert.notEqual(a, b)
  assert.ok(a.length >= 32)
})
