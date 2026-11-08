// tests/helpers/inference-token.mjs —— 造一枚「结构合法」的假推理令牌
//
// 为什么需要：`isInstallationReady()` 现在会校验令牌的 JWT 载荷（`proof_version`、
// `inference_public_key` 与记录一致、`exp` 未过期）。夹具里塞一个裸字符串
// `"inference-token-test"` 会被判成「需要换票」，于是 loader 去走注册链 —— 测试意图被破坏。
//
// 这个 helper 只造**形状**（header.payload.signature 三段、载荷字段与官方一致），
// 不造真签名：测试断言的是「发了什么头」，不是「签名能不能被服务端验过」。

import { createHash } from "node:crypto"

/** 默认有效期：1 小时（远超测试耗时，不会被误判过期） */
export const DEFAULT_TTL_SECONDS = 3600

/**
 * @param {{
 *   inferencePublicKey?: string,   // 必须与安装记录的 inferencePublicKey 一致，否则判 key_mismatch
 *   installationId?: string,
 *   exp?: number,                  // 秒级时间戳
 *   proofVersion?: number,
 *   scope?: string,
 * }} [options]
 * @returns {string} `header.payload.signature` 三段式假令牌
 */
export function fakeInferenceToken({
  inferencePublicKey = "",
  installationId = "",
  exp = Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS,
  proofVersion = 2,
  scope = "scope-test",
} = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      scope,
      proof_version: proofVersion,
      inference_public_key: inferencePublicKey,
      installation_id: installationId,
      iss: "code.phanthy.com",
      aud: "desktop",
      sub: "test",
      iat: Math.floor(Date.now() / 1000),
      exp,
    }),
  ).toString("base64url")
  // 签名不参与任何断言，给个稳定假值即可
  const signature = createHash("sha256").update(`${header}.${payload}`).digest("base64url")
  return `${header}.${payload}.${signature}`
}

/** 已经过期的令牌（用于断言「过期就要换票」） */
export function expiredInferenceToken(options = {}) {
  return fakeInferenceToken({ ...options, exp: Math.floor(Date.now() / 1000) - 60 })
}
