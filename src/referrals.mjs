// src/referrals.mjs —— 「账号自己的邀请链接」：只读资格 + 用该账号自己的设备签名取码
//
// 契约来源：INVITE-SOURCE-CONTRACT.md §3（B1–B13）、INVITE-PROTOCOL.md §3。
// 一句话：`GET /referrals/me` 只给资格**永远没有码**；`POST /referrals/code` 才是
// 「我的邀请链接」的唯一来源，且必须同时满足三件事：
//   ① 设备已注册（该账号自己的 installation 记录，不是推理令牌）；
//   ② `idempotency-key: referral-code:<installationId>:<ms>`（缺它上游回 503）；
//   ③ 该账号自己的 Bearer + 用 identity 私钥签的 v1 头。
//
// ── 这个模块**不做**什么（每一条都是硬约束）─────────────────────────────
//   · 不 bind：`POST /referrals/bind` 不在本模块出现，也不导出它的路径；
//   · 不 force 注册设备：设备没就绪就返回 `device_required`，零 POST；
//     `registrationUnavailableAt` 的 409 熔断期内同样零请求；
//   · 不重试：401 / 409 / 503 / 网络 / 畸形响应一律只发一次，分类后返回；
//   · 不碰推理端点：不调 `activities/summary`，也不签发/使用 `desktop_inference_token`；
//   · 不抓 `/r/<code>`：分享页是登录路径的事（`src/invite.mjs` 的匿名 GET），
//     本模块只把 code 派生成本地字符串，**绝不**带着 Bearer 去请求它；
//   · 不写缓存、不写日志：码 / `invite_code` / `share_url` 一律不进错误文案。
//
// ── 结果形状（固定，调用方不用 try/catch）───────────────────────────────
//
//   fetchReferralMe(auth, opts):
//     { ok: true, me }                                   // 只有资格，没有码
//   | { ok: false, reason: "failed", failure, status }
//
//   fetchReferralCode(auth, { record, ... }):
//     { ok: true, code, inviteCode, shareUrl, slot, slots, me }
//   | { ok: false, reason: "device_required" }            // 本地判据，零请求
//   | { ok: false, reason: "ineligible", eligibilityReason, me }
//   | { ok: false, reason: "failed", failure, status }    // failure 见下方固定词表
//
// `failure` 词表（固定字符串，不含任何上游原文）：
//   device_required | missing_login | signature_invalid | conflict | idempotency_required
//   unavailable | not_supported | rate_limited | invalid_request | invalid_response
//   network | internal | no_code | unauthorized | http_error
//
// ⚠ `request()` 的 v1 canonical 用的是 `new URL(url).pathname`（`src/phanthy-api.mjs`）。
//   本模块的两个端点都**没有 query**，所以签出来是对的；将来若要加
//   `referrals/relations?limit=…`，必须先修 `phanthy-api.mjs` 的 upstreamPath，否则必然 401。

import { TIMEOUT } from "./api.mjs"
import { BASE } from "./context.mjs"
import { identityPrivateKey } from "./device-key.mjs"
import { INVITE_SHARE_PREFIX, referralShareUrl as deriveShareUrl } from "./invite.mjs"
import { installationIdFromPublicKey } from "./installation-id.mjs"
import { trustedUrlOf } from "./origin.mjs"
import { request } from "./phanthy-api.mjs"
import { randomNonce, signCanonical, timestampNow } from "./proof.mjs"
import { isRegistrationBlocked } from "./production-auth.mjs"

/** 只读：我的邀请资格 / 档位 / 额度（纯 Bearer，不签名）。**没有** code / share_url。 */
export const REFERRAL_ME_PATH = "/api/oauth/referrals/me"

/** 写面：生成 / 取回**我的**邀请码。必须签名 + 幂等键 + 设备已注册。 */
export const REFERRAL_CODE_PATH = "/api/oauth/referrals/code"

/** 幂等键前缀（官方前端同形：`referral-code:<installationId>:<ms>`）。 */
export const REFERRAL_CODE_PREFIX = "referral-code"

/** 分享页前缀（与 `src/invite.mjs` 同一份，不另立常量）。 */
export const REFERRAL_SHARE_PREFIX = INVITE_SHARE_PREFIX

/**
 * `POST /referrals/code` 的请求体：**字面量空对象**。
 * `"{}"` 参与 canonical 第 6 段的 sha256，换成别的东西签名必然对不上。
 */
export const REFERRAL_CODE_BODY = Object.freeze({})

/** 有界超时（与数据面同一档：10s）。 */
export const REFERRAL_TIMEOUT_MS = TIMEOUT.short

/** 上游错误码白名单：只读这几个已知字符串，其余一律不采纳（防把 code / share_url 带进结果）。 */
const UPSTREAM_ERROR_CODES = new Set([
  "desktop_installation_required",
  "missing_login",
  "invalid_desktop_signature",
  "idempotency_key_required",
  "desktop_installation_conflict",
  "dependency_unavailable",
])

/** 人读邀请码的白名单（`ABCD-EFGH-JK23` 这种；不做 URL 用途）。 */
const INVITE_CODE_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * URL 用 code 的白名单 —— 与 `src/invite.mjs` 的 C14 判据**逐字一致**
 * （`^[A-Za-z0-9._-]{1,200}$`）。那边是私有常量，无法导入；这里先用同一份拒绝明显
 * 危险的形状（空格 / 换行 / `/`），再用它的 `referralShareUrl` 做 origin 二次确认。
 * 测试里有「两边接受集合一致」的交叉断言，防止以后分叉。
 */
const REFERRAL_CODE_RE = /^[A-Za-z0-9._-]{1,200}$/

function numOf(value) {
  if (value === null || value === undefined || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function textOf(value) {
  return value === null || value === undefined ? "" : String(value)
}

/** `now` 允许是函数（既有代码风格）或毫秒数字；非法值直接抛，由调用方转成 internal。 */
function nowMs(now) {
  const raw = typeof now === "function" ? now() : now === undefined ? Date.now() : now
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms <= 0) throw new TypeError("referrals: now 必须是正数毫秒时间")
  return Math.trunc(ms)
}

/** 由 code 派生分享页 URL；非法 code 返回空串（不抛）。 */
function derivedShareUrlOf(code) {
  try {
    return deriveShareUrl(BASE, code)
  } catch {
    return ""
  }
}

/**
 * code 白名单：复用 `src/invite.mjs` 的 `referralShareUrl`（C14 的唯一判据），
 * 不在这里另写一套正则 —— 两份白名单迟早会分叉。
 */
function normalizeReferralCode(value) {
  const code = typeof value === "string" ? value.trim() : ""
  if (!REFERRAL_CODE_RE.test(code)) return ""
  return derivedShareUrlOf(code) ? code : ""
}

function normalizeInviteCode(value) {
  const text = typeof value === "string" ? value.trim() : ""
  return INVITE_CODE_RE.test(text) ? text : ""
}

/**
 * 同 origin 的分享页 URL。
 *
 * 规则（INVITE-SOURCE-CONTRACT.md B3/B4）：
 *   · 候选 `share_url` 必须是 https + `BASE` 的 origin + 路径正好是 `/r/<code>`；
 *   · 缺失 / 跨 origin / 非 https / 指向别的 code —— 一律丢弃，用 code 派生；
 *   · code 自己不合法 → 空串（不编造链接）。
 *
 * @param {string} code 主码
 * @param {string} [shareUrl] 上游给的候选值（顶层或 slot）
 * @returns {string}
 */
export function trustedShareUrl(code, shareUrl = "") {
  const c = normalizeReferralCode(code)
  if (!c) return ""
  const derived = derivedShareUrlOf(c)
  if (!derived) return ""

  const candidate = textOf(shareUrl).trim()
  if (!candidate) return derived
  try {
    const url = trustedUrlOf(candidate)
    if (url.pathname === `${REFERRAL_SHARE_PREFIX}${c}`) return url.toString()
  } catch {
    // 不可信（跨 origin / 非 https / userinfo / 畸形）→ 派生
  }
  return derived
}

/**
 * 只读 `/referrals/me` 里**已实测过**的字段（C13：未知字段丢弃）。
 *
 * 注意：这里**没有** `code` / `invite_code` / `share_url` / `codes` —— 上游本来就不给，
 * 解析层也不造。`eligible` 只认严格布尔 `eligible_to_invite === true`。
 *
 * @param {*} body 上游 JSON
 * @returns {{schemaVersion: number|null, programStatus: string, eligible: boolean, eligibilityReason: string|null, rewardPoints: number|null, rewardTiers: number[], tierGrantedCount: number|null, tierAllocatedCount: number|null, nextRewardPoints: number|null, dailyLimit: number|null, totalLimit: number|null, remainingSlots: number|null}}
 */
export function readReferralMe(body) {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body : {}
  const referral = value.referral && typeof value.referral === "object" ? value.referral : {}
  return {
    schemaVersion: numOf(value.schema_version),
    programStatus: textOf(referral.program_status),
    eligible: referral.eligible_to_invite === true,
    eligibilityReason:
      referral.eligibility_reason === null || referral.eligibility_reason === undefined
        ? null
        : textOf(referral.eligibility_reason),
    rewardPoints: numOf(referral.reward_points),
    rewardTiers: Array.isArray(referral.reward_tiers)
      ? referral.reward_tiers.map((v) => numOf(v)).filter((v) => v !== null)
      : [],
    tierGrantedCount: numOf(referral.tier_granted_count),
    tierAllocatedCount: numOf(referral.tier_allocated_count),
    nextRewardPoints: numOf(referral.next_reward_points),
    dailyLimit: numOf(referral.daily_limit),
    totalLimit: numOf(referral.total_limit),
    remainingSlots: numOf(referral.remaining_slots),
  }
}

/** 一个 slot（字段白名单；code 不合法就整条丢掉，别缓存一条用不了的）。 */
function readSlot(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
  const slot = entry.slot
  if (!Number.isInteger(slot) || slot <= 0) return null
  const code = normalizeReferralCode(entry.code)
  if (!code) return null
  return {
    slot,
    code,
    inviteCode: normalizeInviteCode(entry.invite_code),
    shareUrl: trustedShareUrl(code, entry.share_url),
  }
}

/**
 * `/referrals/code` 的字段白名单：顶层一对（code / invite_code / share_url）+ 全部 slot。
 * `codes[5]` **全收**（不随机、不按账号挑），主码由 {@link pickPrimarySlot} 决定。
 *
 * @param {*} body 上游 JSON
 * @returns {{schemaVersion: number|null, code: string, inviteCode: string, shareUrl: string, slots: {slot: number, code: string, inviteCode: string, shareUrl: string}[]}}
 */
export function readReferralCode(body) {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body : {}
  const code = normalizeReferralCode(value.code)
  const slots = []
  if (Array.isArray(value.codes)) {
    for (const raw of value.codes) {
      const slot = readSlot(raw)
      if (slot) slots.push(slot)
    }
  }
  return {
    schemaVersion: numOf(value.schema_version),
    code,
    inviteCode: normalizeInviteCode(value.invite_code),
    shareUrl: code ? trustedShareUrl(code, value.share_url) : "",
    slots,
  }
}

/**
 * 主码 = 最小正 slot（通常是 slot 1）。不随机、不按数组顺序、不按 uid 哈希。
 *
 * 只接受：`slot` 是正整数（不强制转字符串）、`code` 过白名单。空数组 → null。
 *
 * @param {Array<{slot?: *, code?: *}>} codes
 * @returns {object|null} 原始条目（readReferralCode 的 slots 则是归一化后的条目）
 */
export function pickPrimarySlot(codes) {
  if (!Array.isArray(codes)) return null
  let best = null
  for (const entry of codes) {
    if (!entry || typeof entry !== "object") continue
    if (!Number.isInteger(entry.slot) || entry.slot <= 0) continue
    if (!normalizeReferralCode(entry.code)) continue
    if (best === null || entry.slot < best.slot) best = entry
  }
  return best
}

/**
 * 官方幂等键：`referral-code:<installationId>:<ms>`。
 *
 * @param {string} installationId 该账号自己的 `di_…`
 * @param {number|(() => number)} [now] 毫秒时间（也接受函数，便于注入）
 * @returns {string}
 */
export function referralCodeIdempotencyKey(installationId, now = Date.now) {
  const id = typeof installationId === "string" ? installationId.trim() : ""
  if (!id) throw new TypeError("referralCodeIdempotencyKey: installationId 必须是非空字符串")
  return `${REFERRAL_CODE_PREFIX}:${id}:${nowMs(now)}`
}

/**
 * 错误分流（纯函数）：只看 HTTP 状态 + 上游的**已知** error.code 白名单。
 *
 * 判定（INVITE-SOURCE-CONTRACT.md §3.8）：
 *   401 `desktop_installation_required` → device_required（**不是** signIn expired）
 *   401 `missing_login`                  → missing_login
 *   401 `invalid_desktop_signature`      → signature_invalid（实现 bug，不重试）
 *   401 `idempotency_key_required`       → idempotency_required
 *   409 `desktop_installation_conflict`  → conflict（终态，不重试）
 *   503 `dependency_unavailable`         → idempotency_required（不是服务故障）
 *   其它 5xx                             → unavailable
 *   429                                  → rate_limited（本模块仍不自动重试）
 *   2xx 却走到这里（JSON 解析失败）        → invalid_response
 *   没有状态（fetch 抛了）                → network
 *
 * 返回对象**不含** message / body / 上游原文 —— 码与链接不进错误。
 *
 * @param {{status?: number, body?: *}} [error]
 * @returns {{failure: string, status: number}}
 */
export function classifyReferralError({ status, body } = {}) {
  const rawStatus = Number(status)
  const s = Number.isFinite(rawStatus) ? Math.trunc(rawStatus) : 0
  const rawCode = body && typeof body === "object" ? body?.error?.code : ""
  const upstream = typeof rawCode === "string" && UPSTREAM_ERROR_CODES.has(rawCode.trim()) ? rawCode.trim() : ""

  if (s >= 200 && s < 300) return { failure: "invalid_response", status: s }

  switch (s) {
    case 0:
      // fetch 抛错（网络 / 超时 / 调用方取消）——没有状态就是这一类
      return { failure: "network", status: 0 }
    case 400:
      return { failure: "invalid_request", status: s }
    case 401:
      if (upstream === "desktop_installation_required") return { failure: "device_required", status: s }
      if (upstream === "missing_login") return { failure: "missing_login", status: s }
      if (upstream === "invalid_desktop_signature") return { failure: "signature_invalid", status: s }
      if (upstream === "idempotency_key_required") return { failure: "idempotency_required", status: s }
      return { failure: "unauthorized", status: s }
    case 404:
      return { failure: "not_supported", status: s }
    case 409:
      return { failure: "conflict", status: s }
    case 429:
      return { failure: "rate_limited", status: s }
    case 503:
      return upstream === "dependency_unavailable"
        ? { failure: "idempotency_required", status: s }
        : { failure: "unavailable", status: s }
    default:
      return s >= 500 ? { failure: "unavailable", status: s } : { failure: "http_error", status: s }
  }
}

/** 把任何异常折成固定失败结果（绝不把 message 带出去） */
function failedResult(error) {
  const { failure, status } = classifyReferralError({ status: error?.status, body: error?.body })
  return { ok: false, reason: "failed", failure, status }
}

/**
 * 设备是否已注册 —— 纯本地判据，不联网、不要求推理令牌。
 *
 * 三条同时满足才算：账号作用域、注册时间、`installationId` 与 identity 公钥同源。
 * 推理令牌（`desktop_inference_token`）是推理面的短效前提，与拿邀请码无关。
 *
 * @param {object|null} record `readInstallation()` / `ensureInstallation()` 的记录
 * @returns {boolean}
 */
export function isDeviceRegistered(record) {
  if (!record || typeof record !== "object") return false
  if (!record.installationId || !record.accountScope || !record.registeredAt) return false
  try {
    return record.installationId === installationIdFromPublicKey(record.publicKey)
  } catch {
    return false
  }
}

/**
 * GET `/referrals/me`：纯 Bearer（**不签名**）、官方 UA、redirect manual、有界超时。
 *
 * 只返回资格；上游没给 code / share_url 是正常的，**不是失败**。
 *
 * @param {object} auth magpie 的 auth（`access` / `key` / `token` 任一）
 * @param {{fetchImpl?: Function, signal?: AbortSignal, timeout?: number}} [options]
 * @returns {Promise<{ok: true, me: ReturnType<typeof readReferralMe>} | {ok: false, reason: "failed", failure: string, status: number}>}
 */
export async function fetchReferralMe(auth, { fetchImpl, signal, timeout = REFERRAL_TIMEOUT_MS } = {}) {
  try {
    const body = await request({
      path: REFERRAL_ME_PATH,
      method: "GET",
      auth,
      fetchImpl,
      signal,
      timeout,
    })
    return { ok: true, me: readReferralMe(body) }
  } catch (error) {
    return failedResult(error)
  }
}

/**
 * 取「这个账号自己的」邀请链接。
 *
 * 顺序是硬约束（INVITE-SOURCE-CONTRACT.md §3.7.5）：
 *   ① 设备未注册 / 409 熔断中 → `device_required` / `conflict`，**零请求**；
 *   ② `GET /referrals/me`（只读）→ 失败就分类返回；
 *   ③ `eligible_to_invite !== true` → `ineligible`，**零 POST**；
 *   ④ 合格才 `POST /referrals/code`（body `{}` + 幂等键 + v1 签名）。
 *
 * 任何失败都返回固定结果，**不抛** —— 调用方（usage / checkin）的主结果不能被它阻断。
 *
 * @param {object} auth 该账号自己的 magpie auth
 * @param {{
 *   record: object,            // 该账号自己的安装记录（`readInstallation(uid)`）
 *   fetchImpl?: Function,
 *   signal?: AbortSignal,
 *   now?: number|(() => number),
 *   nonce?: string,            // 仅测试注入；默认 randomNonce()
 *   timeout?: number,
 * }} options
 * @returns {Promise<
 *   {ok: true, code: string, inviteCode: string, shareUrl: string, slot: number, slots: object[], me: object}
 *   | {ok: false, reason: "device_required"}
 *   | {ok: false, reason: "ineligible", eligibilityReason: string|null, me: object}
 *   | {ok: false, reason: "failed", failure: string, status: number}
 * >}
 */
export async function fetchReferralCode(
  auth,
  { record, fetchImpl, signal, now, nonce, timeout = REFERRAL_TIMEOUT_MS, me: providedMe } = {},
) {
  // ① 本地判据：设备没注册就一条请求都不发（更不能 POST）
  if (!isDeviceRegistered(record)) return { ok: false, reason: "device_required" }

  let at
  try {
    at = nowMs(now)
  } catch {
    return { ok: false, reason: "failed", failure: "internal", status: 0 }
  }

  // ①b 设备注册曾 409：熔断期内零请求（不 force、不换 key 重试）
  if (isRegistrationBlocked(record, () => at)) {
    return { ok: false, reason: "failed", failure: "conflict", status: 409 }
  }

  // ② 只读资格。调用方已经查过就把结果传进来复用 ——
  //    否则每轮采集都会**多打一次** `/referrals/me`（审核 M2）。
  let me = providedMe
  if (!me) {
    const meResult = await fetchReferralMe(auth, { fetchImpl, signal, timeout })
    if (!meResult.ok) return meResult
    me = meResult.me
  }

  // ③ 没资格：不写
  if (me.eligible !== true) {
    return { ok: false, reason: "ineligible", eligibilityReason: me.eligibilityReason, me }
  }

  // ④ 签名 + 幂等键：body 必须是字面量 `{}`（canonical 的第 6 段是它的 sha256）
  let idempotencyKey
  let privateKey
  try {
    idempotencyKey = referralCodeIdempotencyKey(record.installationId, at)
    privateKey = identityPrivateKey(record)
  } catch {
    return { ok: false, reason: "failed", failure: "internal", status: 0 }
  }

  let body
  try {
    body = await request({
      path: REFERRAL_CODE_PATH,
      method: "POST",
      auth,
      body: REFERRAL_CODE_BODY,
      timeout,
      fetchImpl,
      signal,
      sign: {
        installationId: record.installationId,
        idempotencyKey,
        timestamp: timestampNow(() => at),
        nonce: nonce ?? randomNonce(),
        sign: (canonical) => signCanonical(privateKey, canonical),
      },
    })
  } catch (error) {
    return failedResult(error)
  }

  const parsed = readReferralCode(body)
  const primary = pickPrimarySlot(parsed.slots)
  if (!primary) return { ok: false, reason: "failed", failure: "no_code", status: 200 }

  // 顶层 share_url 优先（仅当它对应的就是主码）；否则用该 slot 自己的（已过 origin）
  const sameAsTop = parsed.code === primary.code
  const shareUrl = (sameAsTop && parsed.shareUrl) || primary.shareUrl || trustedShareUrl(primary.code)

  return {
    ok: true,
    code: primary.code,
    inviteCode: primary.inviteCode || (sameAsTop ? parsed.inviteCode : ""),
    shareUrl,
    slot: primary.slot,
    slots: parsed.slots,
    me,
  }
}
