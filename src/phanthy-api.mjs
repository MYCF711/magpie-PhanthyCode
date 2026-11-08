// src/phanthy-api.mjs —— 云端端点清单（数据面 + 待契约的写入面）
//
// 端点全部来自静态观察（前后端与 sidecar 的字符串/分派表），没有一条是猜的：
//
//   GET  /api/phanthy_code/models            模型目录（要求 schema_version === 1）
//   GET  /api/oauth/usage                    套餐 + 用量
//   GET  /api/work/rewards?limit=5           钱包（积分余额）
//   POST /api/oauth/activities/summary       签发 desktop_inference_token（需 v1 签名）
//   POST /api/oauth/desktop-installations/register   设备注册（见 registration.mjs）
//
// 这一层只做「发请求 + 翻译错误」，不拼 UI 形状、不决定降级方向 —— 那是钩子层的活。

import { randomUUID } from "node:crypto"

import { ApiError, TIMEOUT, headersFor, read } from "./api.mjs"
import { BASE } from "./context.mjs"
import {
  CATALOG_PATH,
  CATALOG_STATS_PATH,
  parseCatalog,
} from "./catalog.mjs"
import { randomNonce, signCanonical, timestampNow, v1Canonical } from "./proof.mjs"
import { identityPrivateKey, readInstallation } from "./device-key.mjs"
import { REGISTER_PATH, buildRegistrationRequest } from "./registration.mjs"

/** 使用量汇总端点 */
export const USAGE_PATH = "/api/oauth/usage"

/**
 * 用量汇总端点 —— **套餐名与有效期只在这里**。
 *
 * 实测（2026-11-09，真实账号）：`/api/oauth/usage` 返回的是 `five_hour` /
 * `seven_day` / `current_plan` / `extra_usage` 四组**额度窗口**，**没有** `plan`
 * 节点；套餐名（`体验版`）与 `expires_at` 在 `/api/oauth/usage/summary` 的
 * `plan:{name,expires_at}` 里。早期 `usage-windows.mjs` 读 `usageBody.plan` 永远拿到
 * undefined ⇒ 卡片上「套餐」那一格永远不出现。
 */
export const USAGE_SUMMARY_PATH = "/api/oauth/usage/summary"

/**
 * 账号档案端点 —— `accountScope` 的唯一来源。
 *
 * 官方客户端的 `syncAfterLogin` 顺序是 account() → identity(account.uuid) →
 * register → activities/summary，所以这个 GET 必须排在注册之前。
 */
export const PROFILE_PATH = "/api/oauth/profile"

/** 钱包端点（`?limit=` 是最近流水条数） */
export const WALLET_PATH = "/api/work/rewards"

/** 活动上报 / 推理令牌签发端点 */
export const ACTIVITY_SUMMARY_PATH = "/api/oauth/activities/summary"

/** 数据面默认 UA / 头由 api.mjs 统一给，这里只补签名头 */
function urlOf(path) {
  return path.startsWith("http") ? path : `${BASE}${path}`
}

/**
 * 通用 JSON 请求。`sign` 给了就按 v1 canonical 签一条 `x-desktop-signature`
 * 并附上 `x-desktop-installation-id / -timestamp / -nonce / idempotency-key`。
 *
 * ⚠ `sign` 必须拿到**最终 body 字符串**（先序列化、再签、再把同一个串发出去），
 *   所以这里不接受调用方自带 body 字符串以外的东西。
 */
export async function request({
  path,
  method = "GET",
  auth = {},
  body,
  headers = {},
  sign = null,
  timeout = TIMEOUT.short,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("request: fetchImpl 必须是函数")
  const url = urlOf(path)
  const bodyString = body === undefined ? "" : JSON.stringify(body)
  const extra = { ...headers }

  if (sign) {
    const installationId = String(sign.installationId ?? "").trim()
    if (!installationId) throw new TypeError("request: sign.installationId 必须是非空字符串")
    const timestamp = sign.timestamp ?? timestampNow()
    const nonce = sign.nonce ?? randomNonce()
    // 幂等键**可以为空**：activities/summary 没有幂等键，canonical 第 7 段是空串，
    // 请求头也不发 idempotency-key；register 由 registration.mjs 保证非空。
    const idempotencyKey = String(sign.idempotencyKey ?? "")
    const canonical = v1Canonical({
      method,
      upstreamPath: new URL(url).pathname,
      timestamp,
      nonce,
      body: bodyString,
      idempotencyKey,
    })
    extra["x-desktop-installation-id"] = installationId
    extra["x-desktop-timestamp"] = timestamp
    extra["x-desktop-nonce"] = nonce
    extra["x-desktop-signature"] = sign.sign(canonical)
    if (idempotencyKey) extra["idempotency-key"] = idempotencyKey
  }

  const timeoutSignal = AbortSignal.timeout(timeout)
  const res = await fetchImpl(url, {
    method,
    headers: headersFor(auth, extra),
    body: bodyString === "" ? undefined : bodyString,
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  })
  return read(res, url)
}

/** 模型目录。形状不对 → CatalogShapeError；HTTP 失败 → ApiError */
export async function fetchCatalog(auth, { fetchImpl, signal } = {}) {
  const body = await request({ path: CATALOG_PATH, auth, fetchImpl, signal, timeout: TIMEOUT.short })
  return parseCatalog(body)
}

/** 目录统计（请求量 / 成功率）：失败只返回 null，不影响模型列表 */
export async function fetchCatalogStats(auth, { fetchImpl, signal } = {}) {
  try {
    return await request({ path: CATALOG_STATS_PATH, auth, fetchImpl, signal, timeout: TIMEOUT.short })
  } catch {
    return null
  }
}

/** 账号档案（`account.uuid` 就是 accountScope 的原字符串） */
export async function fetchProfile(auth, { fetchImpl, signal } = {}) {
  return request({ path: PROFILE_PATH, auth, fetchImpl, signal, timeout: TIMEOUT.short })
}

/** 套餐 + 用量（`five_hour` / `seven_day` / `current_plan` / `extra_usage` 四组窗口） */
export async function fetchUsage(auth, { fetchImpl, signal } = {}) {
  return request({ path: USAGE_PATH, auth, fetchImpl, signal, timeout: TIMEOUT.short })
}

/** 用量汇总（`plan:{name,expires_at}` 的唯一来源） */
export async function fetchUsageSummary(auth, { fetchImpl, signal } = {}) {
  return request({ path: USAGE_SUMMARY_PATH, auth, fetchImpl, signal, timeout: TIMEOUT.short })
}

/** 钱包（积分余额） */
export async function fetchWallet(auth, { fetchImpl, signal, limit = 5 } = {}) {
  return request({ path: `${WALLET_PATH}?limit=${encodeURIComponent(limit)}`, auth, fetchImpl, signal })
}

/**
 * 签发 `desktop_inference_token`。
 *
 * 前置：安装记录里已有 `accountScope`（服务端给的），否则 `buildRegistrationRequest`
 * 会抛 `DeviceContractPending` —— 这里不替它猜。
 *
 * body 只有 `inference_public_key`：**inference（sidecar 会话）**那把 ed25519 的
 * SPKI/base64url。⚠ 不是 identity 公钥 —— 实测三把密钥互不相同，令牌绑的是
 * inference 那一把；v1 头签名才是 identity 私钥。
 */
export async function requestInferenceToken({
  auth,
  account,
  fetchImpl,
  signal,
  now = Date.now,
  nonce,
} = {}) {
  const record = readInstallation(account)
  if (!record) throw new ApiError("本机还没有设备安装记录，先完成设备注册", { status: 409, code: "not_implemented" })
  if (!record.accountScope) {
    throw new ApiError("安装记录缺少 accountScope（需要服务端在注册时给出）", {
      status: 409,
      code: "not_implemented",
    })
  }
  if (!record.inferencePublicKey) {
    throw new ApiError("安装记录缺少 inference 公钥（重新跑一次设备注册会补齐）", {
      status: 409,
      code: "not_implemented",
    })
  }

  const body = { inference_public_key: record.inferencePublicKey }
  const privateKey = identityPrivateKey(record)
  const result = await request({
    path: ACTIVITY_SUMMARY_PATH,
    method: "POST",
    auth,
    body,
    timeout: TIMEOUT.long,
    fetchImpl,
    signal,
    sign: {
      installationId: record.installationId,
      idempotencyKey: "",
      timestamp: timestampNow(now),
      nonce: nonce ?? randomNonce(),
      sign: (canonical) => signWith(privateKey, canonical),
    },
  })
  const token = String(result?.desktop_inference_token ?? "").trim()
  if (!token) {
    throw new ApiError("活动汇总响应里没有 desktop_inference_token", {
      status: 502,
      code: "internal_error",
      body: result,
    })
  }
  return { token, serverTime: result?.server_time ?? "", body: result }
}

/** 设备注册（真正的写入面；契约不齐时 registration.mjs 会抛 DeviceContractPending） */
export async function registerDevice({
  auth,
  record,
  policy,
  sessionKeyPublicKey,
  accountScope,
  fetchImpl,
  signal,
  now = Date.now,
  nonce,
} = {}) {
  const built = buildRegistrationRequest({
    record,
    policy,
    sessionKeyPublicKey,
    accountScope,
    // ⚠ 必须三种形状都认：magpie 的插件登录态是 `{ type: "api", key }`，
    //   而探针脚本用 `{ access }`。只读 `auth.access` 会让 magpie 侧注册时
    //   `Authorization: Bearer `（空串）→ 401 missing_login（真机四问暴露）。
    //   与 `src/api.mjs:53` 的 `auth?.access || auth?.token || auth?.key` 保持同一口径。
    accessToken: String(auth?.access || auth?.token || auth?.key || "").trim(),
    now,
    nonce,
  })
  const res = await fetchImpl(urlOf(REGISTER_PATH), {
    method: "POST",
    headers: headersFor({}, built.headers),
    body: built.bodyString,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT.long)])
      : AbortSignal.timeout(TIMEOUT.long),
  })
  const body = await read(res, urlOf(REGISTER_PATH))
  return { request: built, response: body }
}

function signWith(privateKey, canonical) {
  return signCanonical(privateKey, canonical)
}
