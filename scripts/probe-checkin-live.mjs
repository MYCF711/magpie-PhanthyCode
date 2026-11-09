// scripts/probe-checkin-live.mjs —— 真实跑一次生产 `auth.checkin` 钩子的探针（默认只预演）
//
// 用法：
//   node scripts/probe-checkin-live.mjs          # 预演：只打印将执行的影响，不发任何请求
//   node scripts/probe-checkin-live.mjs --yes    # 真实执行一次签到（先读状态，必要时领取今日签到）
//   node scripts/probe-checkin-live.mjs --help
//
// 边界（都是硬约束）：
//   · 只读 magpie `plugin-auth.json` 的 `phanthycode` 节点；不存在或有歧义就清晰报错，
//     **不**静默回退到旧键 `phanthy` 或别的 provider（旧版错读的正是旧键）。
//   · 把**完整 auth 形状**交给插件：type/access/key/refresh/expires/accountId/email/uid/
//     accountScope/metadata。少 `uid` / `accountScope` 就会找不到设备身份（签到报未注册）。
//   · 只打印 outcome / credit / streak / message；message 做脱敏（手机号 / 邮箱 / token 形状）。
//     不打印 access/refresh、installationId、私钥或任何 token。
//   · 不调用 loader，不发任何推理请求。
//   · 真实领取只由显式 `--yes` 打开；无参数时零网络。
//   · 设备身份：生产 checkin 在设备未就绪时会先走
//     profile → register → activities（并在本机写设备密钥），再读 rewards / 领取；
//     注册失败直接 failed、不领取。
//
// 退出码：0 = 预演完成 / 签到成功或今天已签；1 = 签到 failed 或抛错；2 = 用法、登录态或 JSON 问题。
//
// 可测试性：纯函数全部导出；真实执行只发生在文件末尾的 `isMain` 分支里。
// `import` 本文件不产生任何 IO / 网络，因此测试可以安全 import 并注入假插件 / 临时 HOME。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/** magpie `plugin-auth.json` 里的 provider 键（唯一来源） */
export const PROVIDER_KEY = "phanthycode"

/** 登录态文件（刻意只拼这一个，不扫别的 provider） */
export function authFilePath(home = homedir()) {
  return join(home, ".config", "magpie", "plugin-auth.json")
}

/** 交给插件的 auth 字段（完整形状；漏掉 accountScope/metadata 会让签到找不到设备身份） */
export const AUTH_KEYS = Object.freeze([
  "type",
  "access",
  "key",
  "refresh",
  "expires",
  "accountId",
  "email",
  "uid",
  "accountScope",
  "metadata",
])

const USAGE_LINES = [
  "用法：node scripts/probe-checkin-live.mjs [--yes] [--help]",
  "  默认（无参数）只预演：打印将执行的影响，不发送任何请求。",
  "  --yes  真实执行一次签到（先读今日状态，必要时领取今日签到）。",
]

/**
 * 解析参数。只有字面量 `--yes` 才打开真实领取；未知参数一律拒绝（不做模糊匹配）。
 * @param {string[]} argv
 * @returns {{yes: boolean, help: boolean, unknown: string[]}}
 */
export function parseArgs(argv = []) {
  const options = { yes: false, help: false, unknown: [] }
  for (const raw of Array.isArray(argv) ? argv : []) {
    const arg = String(raw)
    if (arg === "--yes") options.yes = true
    else if (arg === "--help" || arg === "-h") options.help = true
    else options.unknown.push(arg)
  }
  return options
}

/** 取登录态里的令牌（access 优先；api 型只有 key） */
export function accessOf(node) {
  return String(node?.access ?? node?.key ?? "").trim()
}

/**
 * 从 magpie 的 `plugin-auth.json` 里取 `phanthycode` 节点。
 *
 * 缺节点、节点形状不对、没有 access/key —— 都抛清晰错误。
 * **绝不回退**到旧键 `phanthy` 或其它 provider：那正是旧版签到时用的错误键。
 *
 * @param {unknown} store 已解析的 plugin-auth.json
 * @param {{file?: string}} [options]
 * @returns {Record<string, unknown>}
 */
export function extractAuthNode(store, { file } = {}) {
  const node = store && typeof store === "object" ? store[PROVIDER_KEY] : undefined
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    const where = file ? `（${file}）` : ""
    throw new Error(
      `没有找到 provider "${PROVIDER_KEY}" 的登录态${where}：` +
        `本脚本只读 .${PROVIDER_KEY} 节点，不回退到其它 provider。` +
        `请先在 magpie 里登录 ${PROVIDER_KEY}，或先跑 scripts/migrate-provider.mjs 迁移旧键。`,
    )
  }
  if (!accessOf(/** @type {Record<string, unknown>} */ (node))) {
    throw new Error(
      `provider "${PROVIDER_KEY}" 的登录态缺少 access/key 令牌，无法签到；请重新登录。`,
    )
  }
  return /** @type {Record<string, unknown>} */ (node)
}

/**
 * 构造交给 `auth.checkin(getAuth)` 的 auth 对象。
 *
 * 原样保留完整形状（含 accountScope / metadata / uid / email）—— 插件按 uid 找本机设备
 * 身份，丢一个字段就会得到「未注册设备」的误判。值不打印、不落盘。
 *
 * @param {Record<string, unknown>} node
 * @returns {Record<string, unknown>}
 */
export function buildCheckinAuth(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new TypeError("buildCheckinAuth: 登录态节点必须是对象")
  }
  if (!accessOf(node)) {
    throw new Error("登录态缺少 access/key 令牌，无法签到")
  }

  const auth = { ...node }
  // metadata 可能是嵌套对象：复制一层，避免插件改到 magpie 原节点（值仍原样保留）
  if (node.metadata && typeof node.metadata === "object") {
    auth.metadata = { .../** @type {Record<string, unknown>} */ (node.metadata) }
  }
  return auth
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE_RE = /(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d{9}(?!\d)/g
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const SK_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g
// 长 token / installationId 形状（`di_…`、base64url 串）。宁可多脱一点，不把凭据打出去。
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{40,}\b/g

/** 已知凭据值（access/key/refresh）：文本里出现就整段替换，不依赖 token 形状 */
export function secretsOf(auth) {
  return [auth?.access, auth?.key, auth?.refresh]
    .filter((value) => typeof value === "string" && value.length >= 8)
    .sort((a, b) => b.length - a.length)
}

/**
 * 脱敏一段人类可读文本：邮箱 → `<邮箱>`，手机号 → `<手机号>`，token 形状 → `<token>`。
 * `secrets` 里的已知凭据值按原值整段替换（比形状匹配更可靠）。
 *
 * @param {unknown} value
 * @param {{secrets?: string[]}} [options]
 * @returns {string}
 */
export function maskMessage(value, { secrets = [] } = {}) {
  let text = String(value ?? "")
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (typeof secret === "string" && secret.length >= 8) text = text.split(secret).join("<token>")
  }
  text = text.replace(EMAIL_RE, "<邮箱>")
  text = text.replace(PHONE_RE, "<手机号>")
  text = text.replace(BEARER_RE, "Bearer <token>")
  text = text.replace(JWT_RE, "<token>")
  text = text.replace(SK_RE, "<token>")
  text = text.replace(LONG_TOKEN_RE, "<token>")
  return text
}

/**
 * 宿主怎么读 checkin 的返回值（`host-*.js` 的 checkinOf）—— 这里只保留这四个字段。
 * @param {unknown} out
 * @param {{secrets?: string[]}} [options]
 * @returns {{outcome: string, credit: number, streak: number, message: string}}
 */
export function summarizeResult(out, { secrets = [] } = {}) {
  const value = out && typeof out === "object" ? /** @type {Record<string, unknown>} */ (out) : {}
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0)
  return {
    outcome: String(value.outcome ?? ""),
    credit: num(value.credit),
    streak: Math.round(num(value.streak)),
    message: maskMessage(value.message, { secrets }),
  }
}

/** 结果行：固定四项，不多打一个字段 */
export function formatSummary(summary) {
  return [
    "=== 签到结果（只含 outcome/credit/streak/message）===",
    `outcome : ${summary.outcome}`,
    `credit  : ${summary.credit}`,
    `streak  : ${summary.streak}`,
    `message : ${summary.message}`,
  ]
}

/** 只列字段名，不列值 —— 让人确认 auth 形状完整，又不会泄漏任何凭据 */
function authShapeLine(auth) {
  const present = AUTH_KEYS.filter((key) => {
    const value = auth[key]
    return value !== undefined && value !== null && value !== ""
  })
  return `  · auth 形状：${present.join(", ") || "（空）"}（只显示字段名，不显示值）`
}

/**
 * 预演文案：把「加了 --yes 会发生什么」说清楚，然后声明零网络。
 *
 * 关于设备身份（account-auth 契约，2026-11-09）：生产 `auth.checkin` 在设备未就绪时
 * 会先 `ensureInstallationReady`（GET /profile → POST /desktop-installations/register
 * → activities，并写本机设备密钥），随后才读 rewards 并领取今日奖励；注册失败则直接
 * failed、不领取。这条链**不发推理请求**，也不经过 loader。
 *
 * @param {Record<string, unknown>} auth
 * @returns {string[]}
 */
export function planLines(auth) {
  return [
    "=== 预演：以下动作只有加 --yes 才会发生（当前零网络请求）===",
    `  · 调用生产 auth.checkin 钩子：provider=${PROVIDER_KEY}`,
    authShapeLine(auth),
    "  · 读取今日签到状态：GET /api/oauth/rewards?type=daily_login（v1 签名请求）",
    "  · 领取今日签到：POST /api/oauth/activities/daily-login/claim" +
      "（幂等键 daily:<installationId>:<UTC+8 日>；今天已领不会重复发放）",
    "  · 设备身份：如尚无，会先完成设备注册（GET /api/oauth/profile → " +
      "POST /api/oauth/desktop-installations/register → activities；会在 ~/.cache/magpie " +
      "写本机设备密钥），随后才读取状态、领取今日奖励；注册失败则直接 failed 且不领取",
    "  · 不会发推理请求，也不会调用 loader",
    "  · 结果只打印 outcome / credit / streak / message；message 已脱敏（手机号 / 邮箱 / token 形状）",
    "未加 --yes：以上均未执行，没有发送任何请求。",
  ]
}

/**
 * 执行探针。所有副作用（读文件、建插件、调 checkin）都经由注入参数，便于测试。
 *
 * @param {{
 *   argv?: string[],
 *   home?: string,
 *   readFile?: (path: string, encoding: string) => string,
 *   pluginFactory?: Function,
 *   pluginOptions?: Record<string, unknown>,
 *   stdout?: (line: string) => void,
 *   stderr?: (line: string) => void,
 * }} [options]
 * @returns {Promise<{code: number, executed: boolean}>}
 */
export async function run(options = {}) {
  const {
    argv = process.argv.slice(2),
    home = homedir(),
    readFile = readFileSync,
    pluginFactory,
    pluginOptions = {},
    stdout = (line) => console.log(line),
    stderr = (line) => console.error(line),
  } = options

  const args = parseArgs(argv)
  if (args.help) {
    for (const line of USAGE_LINES) stdout(line)
    return { code: 0, executed: false }
  }
  if (args.unknown.length > 0) {
    stderr(`✖ 未知参数：${args.unknown.join(" ")}（只认 --yes / --help）`)
    for (const line of USAGE_LINES) stderr(line)
    return { code: 2, executed: false }
  }

  const file = authFilePath(home)
  let text
  try {
    text = readFile(file, "utf8")
  } catch (error) {
    stderr(`✖ 读不到 magpie 的插件登录态：${file}（${error?.code ?? error?.message ?? "unknown"}）`)
    stderr(`  请先在 magpie 里登录 ${PROVIDER_KEY}；本脚本只读这一份登录态，不读桌面端凭据。`)
    return { code: 2, executed: false }
  }

  let store
  try {
    store = JSON.parse(text)
  } catch (error) {
    stderr(`✖ ${file} 不是合法 JSON：${maskMessage(error?.message ?? error)}`)
    return { code: 2, executed: false }
  }

  let node
  let auth
  try {
    node = extractAuthNode(store, { file })
    auth = buildCheckinAuth(node)
  } catch (error) {
    stderr(`✖ ${maskMessage(error?.message ?? error)}`)
    return { code: 2, executed: false }
  }

  if (!args.yes) {
    for (const line of planLines(auth)) stdout(line)
    return { code: 0, executed: false }
  }

  stdout(`执行真实签到（provider=${PROVIDER_KEY}）…`)

  let out
  try {
    const factory =
      pluginFactory ?? (await import("../index.mjs")).PhanthyCodeAuthPlugin
    const plugin = await factory({}, { fetch: globalThis.fetch, ...pluginOptions })
    // 完全按宿主的方式调用：getAuth 返回完整 auth，provider = { id }
    out = await plugin.auth.checkin(async () => auth, { id: PROVIDER_KEY })
  } catch (error) {
    const summary = summarizeResult(
      { outcome: "failed", message: error?.message ?? error },
      { secrets: secretsOf(auth) },
    )
    for (const line of formatSummary(summary)) stdout(line)
    return { code: 1, executed: true }
  }

  const summary = summarizeResult(out, { secrets: secretsOf(auth) })
  for (const line of formatSummary(summary)) stdout(line)
  return { code: summary.outcome === "failed" ? 1 : 0, executed: true }
}

// ───────────────────────── 直接执行入口（放文件末尾：import 本文件零副作用）─────────────────────────

const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
})()

if (isMain) {
  const result = await run({ argv: process.argv.slice(2) })
  if (result.code !== 0) process.exitCode = result.code
}
