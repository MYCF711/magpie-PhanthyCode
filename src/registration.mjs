// src/registration.mjs —— 设备注册请求的构造（含两条签名的 canonical）
//
// 这个模块**只构造请求**，不发请求。端点：
//   POST /api/oauth/desktop-installations/register
//
// ── 契约（2026-11-09 真机实测确认，HTTP 200）───────────────────────────
//
// 早先这里写着「三项静态不可判定」，现在三项全定了：
//
//   ① device_public_key **必须**与 public_key 不同（三把独立 ed25519 密钥）；
//   ② body.device_signature 用 **device 私钥**签 device canonical；
//      （用 identity 私钥签在真机上失败 —— 两种都试过，200 的是 device）
//   ③ 请求头 x-desktop-signature 用 **identity 私钥**签 v1 canonical。
//
// 还有一条不在 canonical 里、但同样被实测钉死的：`inference_public_key` 是
// **inference**（sidecar 会话）那把公钥，每次注册换新；12 段推理证明也用它签。
//
// 这三项仍然**由调用方显式给出**（`policy`），没有默认值、没有「猜一个」：
// 契约再变一次的时候，改的是 `src/production-auth.mjs` 的 `IDENTITY_POLICY` 一处，
// 而不是散落在这个文件里的隐式假设。缺字段仍然抛 `DeviceContractPending`。
//
// 证据：`App-Y9eSJNhB.js` 的 `Co()`：先构造
//   {public_key, edition, platform, version}，再注入
//   {device_public_key, device_signature, inference_public_key}，然后对**最终
//   body 字符串**算 sha256 并签 v1 头。注入顺序不能变 —— 签名覆盖的是最终字节。

import {
  deviceCanonical,
  randomNonce,
  signCanonical,
  timestampNow,
  v1Canonical,
} from "./proof.mjs"
import { devicePrivateKey, identityPrivateKey } from "./device-key.mjs"

/** 注册端点（云端路径，参与 v1 签名，不能写成本地路径） */
export const REGISTER_PATH = "/api/oauth/desktop-installations/register"

/** edition 取值：`xo()` 在 phanthy_work 产品下返回这个字面量 */
export const EDITION = "phanthy_work"

/**
 * `body.version` —— **官方客户端的版本号**，不是插件的版本号。
 *
 * 2026-11-09 抓包实测就是 `2.48.0`（旧值 `0.1.0` 是插件自己的版本，服务端不认）。
 * ⚠ 改它等于冒充另一个客户端版本：官方发新版要跟着改，但**不要**把它和
 *   `package.json.version` 绑在一起 —— 插件版本是 0.2.x，两者互不代表。
 */
export const PLUGIN_VERSION = "2.48.0"

/** 幂等键格式：`register:<installationId>`，且它本身参与签名 */
export function idempotencyKeyFor(installationId) {
  if (typeof installationId !== "string" || installationId.trim() === "") {
    throw new TypeError("idempotencyKeyFor: installationId 必须是非空字符串")
  }
  return `register:${installationId}`
}

/**
 * `accountScope` 的唯一来源：账号档案 `GET /api/oauth/profile` 的 `account.uuid`。
 *
 * 为什么写成一个独立函数：device canonical 第 2 段、活动签名、以及 Rust 侧
 * 派生键都用这**同一个字符串**。它没有默认值，也不允许回退 —— 官方客户端就是
 * `wo.identity(account.uuid)` 把档案里的字符串原样传下去
 * （`App-Y9eSJNhB.js` @109191 → @102437 → @101016/@101403）。
 *
 * ⚠ 它**不参与 installationId 派生**（那条走公钥，见 `src/installation-id.mjs`）。
 *   早期实现拿它哈希出 id，是 409 `desktop_installation_conflict` 的根因。
 *
 * 明确不允许的替代品：JWT 的 `sub`（客户端只拿它比较「身份变没变」）、邮箱、
 * edition、产品名。用它们只会得到 `desktop_binding_invalid`，而且看不出原因。
 *
 * @param {unknown} body `GET /api/oauth/profile` 的响应体
 * @returns {string} `account.uuid` 原字符串
 */
export function accountScopeFromProfile(body) {
  const uuid = body?.account?.uuid
  if (typeof uuid !== "string" || uuid.trim() === "") {
    throw Object.assign(
      new Error(
        "账号档案里没有 account.uuid：accountScope 只能从这里取，" +
          "不能用 JWT sub / 邮箱 / edition 代替；先确认 GET /api/oauth/profile 的响应形状",
      ),
      { code: "internal_error", status: 502, reason: "account_scope_missing" },
    )
  }
  return uuid
}

/** 平台名：与官方客户端一致的三档 */
export function platformName(platform = process.platform) {
  if (platform === "win32") return "windows"
  if (platform === "darwin") return "macos"
  return "linux"
}

/** 契约不完整时抛这个：`gaps` 是给人看的待确认项 */
export class DeviceContractPending extends Error {
  constructor(gaps) {
    super(
      `设备注册契约未确认：${gaps.join("；")}。` +
        `三项签名/密钥语义由 policy 显式给出（见 src/production-auth.mjs 的 IDENTITY_POLICY），` +
        `缺字段时插件不猜。`,
    )
    this.name = "DeviceContractPending"
    this.code = "device_contract_pending"
    this.gaps = gaps
  }
}

const SIGNERS = new Set(["identity", "device"])

/**
 * 校验并归一契约。
 *
 * @param {{
 *   bindingSigner?: "identity"|"device",
 *   headerSigner?: "identity"|"device",
 *   deviceKeyDistinct?: boolean,
 * }} [policy]
 * @returns {{bindingSigner:string, headerSigner:string, deviceKeyDistinct:boolean}}
 */
export function normalizePolicy(policy) {
  if (!policy || typeof policy !== "object") {
    throw new DeviceContractPending([
      "device_signature 用哪把私钥签",
      "x-desktop-signature 用哪把私钥签",
      "device_public_key 是否必须与 public_key 不同",
    ])
  }
  const gaps = []
  if (!SIGNERS.has(policy.bindingSigner)) gaps.push("device_signature 用哪把私钥签")
  if (!SIGNERS.has(policy.headerSigner)) gaps.push("x-desktop-signature 用哪把私钥签")
  if (typeof policy.deviceKeyDistinct !== "boolean") gaps.push("device_public_key 是否必须与 public_key 不同")
  if (gaps.length > 0) throw new DeviceContractPending(gaps)
  return {
    bindingSigner: policy.bindingSigner,
    headerSigner: policy.headerSigner,
    deviceKeyDistinct: policy.deviceKeyDistinct,
  }
}

/**
 * 请求体（字段顺序按官方客户端注入顺序；JSON.stringify 保序，签名覆盖这个串）。
 */
export function registrationBody({
  publicKey,
  devicePublicKey,
  deviceSignature,
  inferencePublicKey,
  edition = EDITION,
  platform = platformName(),
  version = PLUGIN_VERSION,
} = {}) {
  for (const [name, value] of Object.entries({ publicKey, devicePublicKey, deviceSignature, inferencePublicKey })) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`registrationBody: ${name} 必须是非空字符串`)
    }
  }
  return {
    public_key: publicKey,
    edition,
    platform,
    version,
    device_public_key: devicePublicKey,
    device_signature: deviceSignature,
    inference_public_key: inferencePublicKey,
  }
}

/** 按契约取签名私钥：`device` 走 device 私钥，其余走 identity 私钥 */
function signerFor(record, signer) {
  return signer === "device" ? devicePrivateKey(record) : identityPrivateKey(record)
}

/**
 * 构造一次注册请求：body + device 签名 + v1 头签名 + 头。
 *
 * @param {{
 *   record: object,                 // device-key 的安装记录（三把密钥）
 *   policy: object,                 // 显式契约（normalizePolicy 的结果或其原文）
 *   sessionKeyPublicKey: string,    // inference（sidecar 会话）公钥，进 body.inference_public_key
 *   accountScope?: string,          // device canonical 第 2 段；默认取记录里的服务端值
 *   accessToken: string,            // OAuth access，放 Authorization
 *   now?: () => number,
 *   nonce?: string,
 *   autoSign?: boolean,             // false 时只返回 body 与 canonical，不签名（离线测试用）
 * }} options
 */
export function buildRegistrationRequest({
  record,
  policy,
  sessionKeyPublicKey,
  accountScope,
  accessToken,
  now = Date.now,
  nonce,
  autoSign = true,
} = {}) {
  if (!record?.installationId || !record?.publicKey) {
    throw new TypeError("buildRegistrationRequest: record 缺少 installationId 或 publicKey")
  }
  if (typeof sessionKeyPublicKey !== "string" || sessionKeyPublicKey.trim() === "") {
    throw new TypeError("buildRegistrationRequest: sessionKeyPublicKey 必须是非空字符串（inference 会话公钥）")
  }
  const contract = normalizePolicy(policy)
  const scope = String(accountScope ?? record.accountScope ?? "").trim()
  if (!scope) {
    throw new DeviceContractPending(["accountScope：注册时用哪个作用域（本地无从推断，需服务端给出）"])
  }

  // device_public_key：契约说「必须不同」时用记录里那把独立的 device 公钥；
  // 说「可以相同」时用 identity 公钥（历史形态，只在显式关闭 deviceKeyDistinct 时出现）。
  const devicePublicKey = contract.deviceKeyDistinct ? String(record.devicePublicKey ?? "").trim() : record.publicKey
  if (contract.deviceKeyDistinct && !devicePublicKey) {
    throw new DeviceContractPending([
      "device_public_key 需要一把与 public_key 不同的密钥，但安装记录里没有 device 密钥（先跑 ensureInstallation 的密钥迁移）",
    ])
  }

  const timestamp = timestampNow(now)
  const nonceValue = nonce ?? randomNonce()

  // 先用占位签名算出 device canonical（device_signature 不在 canonical 里，
  // 所以先算 canonical 再签、再回填 body，顺序是安全的）。
  const canonical = deviceCanonical({
    accountScope: scope,
    installationId: record.installationId,
    publicKey: record.publicKey,
    sessionKeyPublicKey,
    timestamp,
    nonce: nonceValue,
  })

  // 两条签名各用各的私钥（实测：device canonical 用 device、v1 头用 identity）。
  // autoSign=false 时两把都不需要（离线测试只验形状）。
  const bindingKey = autoSign ? signerFor(record, contract.bindingSigner) : null
  const headerKey = autoSign ? signerFor(record, contract.headerSigner) : null
  const deviceSignature = autoSign ? signCanonical(bindingKey, canonical) : "SIGNATURE_PENDING"

  const body = registrationBody({
    publicKey: record.publicKey,
    devicePublicKey,
    deviceSignature,
    inferencePublicKey: sessionKeyPublicKey,
  })
  // ⚠ 签名覆盖的是**最终 body 字符串**：先序列化，再算 v1，再把同一个串发出去。
  const bodyString = JSON.stringify(body)
  const idempotencyKey = idempotencyKeyFor(record.installationId)
  const headerCanonical = v1Canonical({
    method: "POST",
    upstreamPath: REGISTER_PATH,
    timestamp,
    nonce: nonceValue,
    body: bodyString,
    idempotencyKey,
  })
  const headerSignature = autoSign ? signCanonical(headerKey, headerCanonical) : "SIGNATURE_PENDING"

  return {
    body,
    bodyString,
    idempotencyKey,
    timestamp,
    nonce: nonceValue,
    canonical: { device: canonical, header: headerCanonical },
    signature: { device: deviceSignature, header: headerSignature },
    signers: { device: contract.bindingSigner, header: contract.headerSigner },
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${String(accessToken ?? "")}`,
      "x-desktop-installation-id": record.installationId,
      "x-desktop-timestamp": timestamp,
      "x-desktop-nonce": nonceValue,
      "x-desktop-signature": headerSignature,
      "idempotency-key": idempotencyKey,
    },
  }
}
