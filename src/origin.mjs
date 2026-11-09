// src/origin.mjs —— 出站 URL 的 origin 闸门（唯一的「这个 URL 可信吗」判据）
//
// 为什么需要这一层：插件把**用户凭据**发到 `input` 指向的地方 —— Bearer access token
// （`src/api.mjs` 的 `headersFor`）、设备签名头（`src/phanthy-api.mjs` 的 v1 canonical）。
// 只要有一条出口接受「绝对 URL 原样转发」，一次拼装错误（把端点常量拼进请求、
// 或者上游响应里回一个 URL）就把账号送给了别的主机。而这类错**不会报错**：
// 请求成功、日志干净、用户只是从此收不到额度。
//
// 判据（不做近似匹配，逐字比 origin）：
//   ① protocol 必须 `https:`
//   ② origin 必须与 `src/context.mjs` 的 `BASE` **完全一致**（`URL.origin` 相等）
//   ③ 不允许 userinfo（`https://user:pass@host` 与 `https://trusted@evil` 都拒绝 ——
//      前者把凭据写进 URL，后者是经典伪装）
//   ④ 相对路径只能是「以单个 `/` 开头」的 path：`//host/x` 是协议相对的绝对 URL，
//      反斜杠在不同解析器里有分隔符语义，两者都不当相对路径用
//
// ⚠ 错误信息里**不回显 userinfo**（把密码原样写进日志 = 第二次泄漏）。

import { BASE } from "./context.mjs"

/** 可信基址（与 `src/context.mjs` 同一份，改这里等于改整个插件的出站边界） */
export const TRUSTED_BASE = BASE

/** URL 不在可信 origin 上。`reason` 便于区分是「协议 / 凭据 / 主机 / 路径」哪一种。 */
export class UntrustedUrlError extends Error {
  constructor(message, { url = "", reason = "" } = {}) {
    super(message)
    this.name = "UntrustedUrlError"
    // 不是 magpie 的 code 词表（宿主不读这个字段），但调用方与测试要靠它分流
    this.code = "untrusted_origin"
    this.url = url
    this.reason = reason
  }
}

/** 错误文本里出现 URL 时，先抹掉 userinfo 再截断（凭据不进日志） */
function describe(input) {
  const text = String(input ?? "")
  return text.replace(/\/\/[^/@\s]*@/, "//***@").slice(0, 160)
}

function baseUrlOf(base) {
  try {
    return new URL(String(base))
  } catch {
    throw new UntrustedUrlError(`BASE 不是可解析的 URL：${describe(base)}`, {
      url: describe(base),
      reason: "base",
    })
  }
}

/** 可信 origin（`https://code.phanthy.com`）—— 唯一的比较基准 */
export function trustedOrigin(base = BASE) {
  return baseUrlOf(base).origin
}

/**
 * 绝对 URL 闸门：不合格就抛，合格原样返回 `URL`（调用方拿到的一定是可信主机的 URL）。
 *
 * @param {string|URL} input
 * @param {{base?: string}} [options]
 * @returns {URL}
 */
export function assertTrustedUrl(input, { base = BASE } = {}) {
  const raw = input instanceof URL ? input.href : typeof input === "string" ? input : ""
  const shown = describe(raw)

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new UntrustedUrlError(`不是可解析的绝对 URL（无协议或畸形）：${shown}`, {
      url: shown,
      reason: "not-absolute",
    })
  }

  if (url.protocol !== "https:") {
    throw new UntrustedUrlError(`出站 URL 必须是 https，实际是 ${url.protocol}：${shown}`, {
      url: shown,
      reason: "protocol",
    })
  }
  if (url.username || url.password) {
    throw new UntrustedUrlError(`出站 URL 不许带 userinfo（凭据只能走请求头）：${shown}`, {
      url: shown,
      reason: "userinfo",
    })
  }

  const expected = trustedOrigin(base)
  if (url.origin !== expected) {
    // 逐字比 origin：`code.phanthy.com.evil.com` / `evil.phanthy.com` / 非默认端口全部落这里
    throw new UntrustedUrlError(`出站 URL 的 origin 是 ${url.origin}，只允许 ${expected}：${shown}`, {
      url: shown,
      reason: "origin",
    })
  }
  return url
}

/**
 * 相对路径闸门：必须是单个 `/` 开头的 path，按 BASE 拼成绝对 URL 后再过一遍
 * `assertTrustedUrl`（两道判断都保留：拼错的 base 也不会被放过）。
 *
 * @param {string} path
 * @param {{base?: string}} [options]
 * @returns {URL}
 */
export function pathUrl(path, { base = BASE } = {}) {
  const raw = typeof path === "string" ? path.trim() : ""
  if (!raw.startsWith("/")) {
    throw new UntrustedUrlError(`相对路径必须以 / 开头：${describe(raw)}`, { url: describe(raw), reason: "path" })
  }
  if (raw.startsWith("//")) {
    throw new UntrustedUrlError(`协议相对 URL（//host）不是相对路径：${describe(raw)}`, {
      url: describe(raw),
      reason: "protocol-relative",
    })
  }
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) {
    // 反斜杠（`/\evil.com`）与控制字符（`/api\r\nx`）在不同解析器/头拼装里有分隔符语义
    throw new UntrustedUrlError(`相对路径里不许有反斜杠或控制字符：${describe(raw)}`, {
      url: describe(raw),
      reason: "path",
    })
  }
  const trimmedBase = String(base).replace(/\/+$/, "")
  return assertTrustedUrl(`${trimmedBase}${raw}`, { base })
}

/**
 * 出口统一入口：绝对 URL 走 `assertTrustedUrl`，相对路径走 `pathUrl`。
 *
 * 「有没有协议」只看开头是不是 `<scheme>:`；`//host/x` 不算绝对 URL，
 * 会被 `pathUrl` 按协议相对拒掉（不能落到 `new URL(x, base)` 的相对解析上）。
 *
 * @param {string|URL} input
 * @param {{base?: string}} [options]
 * @returns {URL}
 */
export function trustedUrlOf(input, { base = BASE } = {}) {
  if (input instanceof URL) return assertTrustedUrl(input, { base })
  const raw = typeof input === "string" ? input : ""
  return /^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) ? assertTrustedUrl(raw, { base }) : pathUrl(raw, { base })
}
