// tests/local-import.test.mjs —— 本机导入：真实落点、嵌套字段、过期判定（离线，全部虚构值）
//
// 真实落点：`%USERPROFILE%\.phanthy-code\.credentials.json`，顶层 `claudeAiOauth`。
// 红线：只导入未过期的云端 access token；refresh / 推理令牌 / 设备私钥一律拒绝，
// 且任何输出（报告、错误消息、摘要）都不能出现值。

import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  LocalImportError,
  candidateFiles,
  classifyCredential,
  credentialsFile,
  describe,
  detectLocalLogin,
  oauthNode,
  readImportedAccess,
  remainingSeconds,
  summarizeDetection,
} from "../src/local-import.mjs"

const ACCESS = "access-token-fictional-value"
const REFRESH = "refresh-token-fictional-value"
const NOW = () => 1_767_225_600_000

function sandbox(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "pw-local-"))
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8")
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function creds(fields) {
  return { claudeAiOauth: fields }
}

test("落点：~/.phanthy-code/.credentials.json，只有这一个候选", () => {
  const file = credentialsFile("/home/tester")
  assert.equal(file, join("/home/tester", ".phanthy-code", ".credentials.json"))
  assert.deepEqual(candidateFiles("/home/tester"), [file])
})

test("嵌套：默认读 claudeAiOauth 节点；没有该节点时退回顶层", () => {
  assert.deepEqual(oauthNode(creds({ accessToken: ACCESS })), { accessToken: ACCESS })
  assert.deepEqual(oauthNode({ accessToken: ACCESS }), { accessToken: ACCESS })
  assert.equal(oauthNode(null), null)
})

test("剩余秒数：未来为正、过去为负、缺失为 null", () => {
  assert.equal(remainingSeconds(1_767_225_600_000 + 60_000, NOW), 60)
  assert.equal(remainingSeconds(1_767_225_600_000 - 60_000, NOW), -60)
  assert.equal(remainingSeconds(undefined, NOW), null)
  assert.equal(remainingSeconds(0, NOW), null)
})

test("分类：未过期 access 可导入；过期/缺过期时间都不可导入", () => {
  const fresh = classifyCredential(creds({ accessToken: ACCESS, expiresAt: 1_767_225_600_000 + 3_600_000 }), { now: NOW })
  assert.equal(fresh.kind, "cloud_access")
  assert.equal(fresh.importable, true)
  assert.equal(fresh.remainingSeconds, 3600)

  const expired = classifyCredential(creds({ accessToken: ACCESS, expiresAt: 1_767_225_600_000 - 2_433_000 }), { now: NOW })
  assert.equal(expired.kind, "cloud_access_expired")
  assert.equal(expired.importable, false)
  assert.equal(expired.expired, true)
  assert.equal(expired.remainingSeconds, -2433)
  assert.match(expired.reason, /过期|OAuth/)

  const noExpiry = classifyCredential(creds({ accessToken: ACCESS }), { now: NOW })
  assert.equal(noExpiry.kind, "cloud_access_no_expiry")
  assert.equal(noExpiry.importable, false)
  assert.match(noExpiry.reason, /expiresAt/)
})

test("分类：refresh / 桥 / 设备私钥一律拒绝，且字段名不泄露值", () => {
  const cases = [
    [creds({ refreshToken: REFRESH }), "refresh_only"],
    [creds({ ANTHROPIC_AUTH_TOKEN: "bridge-token" }), "bridge_bearer"],
    [creds({ desktop_inference_token: "inference-token" }), "device_secret"],
    [creds({ privateKey: "pkcs8-bytes" }), "device_secret"],
    [{}, "unknown"],
    [null, "empty"],
  ]
  for (const [config, kind] of cases) {
    const result = classifyCredential(config, { now: NOW })
    assert.equal(result.kind, kind, `分类错误：${JSON.stringify(config)}`)
    assert.equal(result.importable, false)
    const text = JSON.stringify(result)
    assert.equal(text.includes(ACCESS), false)
    assert.equal(text.includes(REFRESH), false)
    assert.equal(text.includes("bridge-token"), false)
  }
})

test("describe 只给类型，不给值", () => {
  const shape = describe(creds({ accessToken: ACCESS, refreshToken: REFRESH }))
  const text = JSON.stringify(shape)
  assert.equal(text.includes(ACCESS), false)
  assert.equal(text.includes(REFRESH), false)
  assert.equal(shape.claudeAiOauth.accessToken, "string")
})

test("检测：文件不存在 → found=false，不抛", () => {
  const box = sandbox()
  try {
    const detection = detectLocalLogin({ home: box.root })
    assert.equal(detection.found, false)
    assert.equal(detection.importable, false)
    assert.equal(detection.candidates[0].exists, false)
  } finally {
    box.cleanup()
  }
})

test("检测：未过期 → 可导入，且摘要里没有值、带剩余秒数", () => {
  const box = sandbox({
    ".phanthy-code/.credentials.json": creds({ accessToken: ACCESS, expiresAt: 1_767_225_600_000 + 1_200_000 }),
  })
  try {
    const detection = detectLocalLogin({ home: box.root, now: NOW })
    assert.equal(detection.found, true)
    assert.equal(detection.importable, true)
    assert.equal(JSON.stringify(detection).includes(ACCESS), false)

    const summary = summarizeDetection(detection)
    assert.equal(summary.importable, true)
    assert.match(summary.lines[0], /剩余 1200 秒/)

    const imported = readImportedAccess({ home: box.root, now: NOW })
    assert.equal(imported.access, ACCESS)
    assert.equal(imported.expires, 1_767_225_600_000 + 1_200_000)
    assert.equal(imported.remainingSeconds, 1200)
    assert.deepEqual(Object.keys(imported).sort(), ["access", "expires", "importedAt", "remainingSeconds", "sourceFile"])
  } finally {
    box.cleanup()
  }
})

test("检测：本机这种「已过期」状态 → 不可导入，摘要写明过期", () => {
  const box = sandbox({
    ".phanthy-code/.credentials.json": creds({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: 1_767_225_600_000 - 2_433_000,
    }),
  })
  try {
    const detection = detectLocalLogin({ home: box.root, now: NOW })
    assert.equal(detection.found, true)
    assert.equal(detection.importable, false)
    assert.equal(detection.candidates[0].classification.kind, "cloud_access_expired")
    assert.match(summarizeDetection(detection).lines[0], /不可导入/)
    assert.equal(JSON.stringify(detection).includes(REFRESH), false)

    assert.throws(
      () => readImportedAccess({ home: box.root, now: NOW }),
      (error) => {
        assert.ok(error instanceof LocalImportError)
        assert.equal(error.reason, "local_token_expired")
        assert.equal(error.message.includes(REFRESH), false)
        return true
      },
    )
  } finally {
    box.cleanup()
  }
})

test("导入：只有 refresh → 明确拒绝，并说明会顶掉桌面端", () => {
  const box = sandbox({ ".phanthy-code/.credentials.json": creds({ refreshToken: REFRESH }) })
  try {
    assert.throws(
      () => readImportedAccess({ home: box.root, now: NOW }),
      (error) => error instanceof LocalImportError && /refresh_token|掉线/.test(error.message),
    )
  } finally {
    box.cleanup()
  }
})

test("导入：坏 JSON / 缺文件都明确报错", () => {
  const broken = sandbox({ ".phanthy-code/.credentials.json": "{not json" })
  try {
    assert.throws(() => readImportedAccess({ home: broken.root, now: NOW }), LocalImportError)
  } finally {
    broken.cleanup()
  }
  const empty = sandbox()
  try {
    assert.throws(
      () => readImportedAccess({ home: empty.root, now: NOW }),
      (error) => error instanceof LocalImportError && /没有可导入/.test(error.message),
    )
  } finally {
    empty.cleanup()
  }
})
