// src/preferred.mjs —— 「magpie 首选账号」的只读解析（logins.json → plugin-auth.json → uid）
//
// ═══════════════════════════════════════════════════════════════════
// 为什么需要这个模块
// ═══════════════════════════════════════════════════════════════════
//
// magpie 0.1.3371 没有「插件声明账号下拉框」的原生入口；账号行上的
// 「Make first」是唯一原生选择器，它落盘到 `~/.config/magpie/logins.json`
// 的 `first` / `order`。插件对宿主目录只有读的份，只能从这里推断首选账号。
//
// 参考实现是 `magpie-opc-auth/src/invite.mjs` 的 `preferredHome` /
// `preferredAccount`；但那两处用的是 opc 自己的 `uid` / `org` 兜底，**本插件
// 不能照抄**：PhanthyCode 的稳定身份只有 `metadata.userId`
// （= `fingerprint(accountScope)`，见 `src/credential.mjs` 的 `uidOf`）。
//
// ═══════════════════════════════════════════════════════════════════
// 三条硬规矩（写错都不报错，用户也看不出）
// ═══════════════════════════════════════════════════════════════════
//
//   ① 身份只能取 `metadata.userId`。`accountId` / 手机号 / `home` 都可重名、
//      可改名、重登会变 —— 用它们当键，同一个人换一次 token 就变成两个人：
//      邀请挂到别人名下、缓存各写一份，界面一切正常。
//   ② 只读身份与选择字段（`agent` / `home` / `first` / `order` /
//      `metadata.userId` / `accountId`），**绝不**读 `key` / `access` /
//      `refresh` / `token`；返回值里也不允许出现它们。
//   ③ 读不到 / 文件坏 / 结构变了 → 返回 `reason`，**绝不抛**。
//      宿主里抛出去 = 整个插件在列表里消失。
//
// `reason` 词表见 `PREFERRED_REASONS`。它们**不是** HTTP 错误码（那套在
// `src/http.mjs` 的 `CODES`），只回答「为什么没拿到首选 uid」，只给展示与排查用。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * 读取「首选账号」时的固定 reason 词表。
 *
 * 集中一处：调用方要按它映射文案，而且 `check.mjs` 的错误码形态扫描
 * （R2 的裸字符串 `return "…"`）只认「函数名含 code」的返回值 ——
 * 词表集中后，这里返回的永远是常量，不会被误判成 HTTP 错误码。
 */
export const PREFERRED_REASONS = Object.freeze({
  /** 拿到了稳定 uid */
  ok: "ok",
  /** `logins.json` 不存在（没装 magpie / 还没登录过） */
  noLogins: "no_logins",
  /** 文件是数组，但没有 `agent === "plugin:<provider>"` 的行 */
  noRow: "no_row",
  /** 有本 provider 的行，但 `home` 全是空 / 空白 */
  noHome: "no_home",
  /** 首选 `home` 在 `plugin-auth.json` 里没有条目（或条目不是对象） */
  noAuthEntry: "no_auth_entry",
  /** 条目在，但 `metadata.userId` 不是非空字符串 */
  noUid: "no_uid",
  /** 参数不合法，或文件存在但内容坏（坏 JSON / 非数组 / 非对象） */
  badConfig: "bad_config",
})

/** 普通对象（`plugin-auth.json` 的条目、`logins.json` 的行都必须是这种形状） */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** 只接受字符串（两端空白去掉）；其它类型一律当空串 —— 不对值做任何转换或猜测 */
function textOf(value) {
  return typeof value === "string" ? value.trim() : ""
}

/** 失败结果：形状固定四个键，`uid` 永远是空串（调用方不必判空） */
function failure(reason, home = "", accountId = "") {
  return { uid: "", home, accountId, reason }
}

/** `accountId` 只用于展示：字符串取 trim，有限数字转字符串，其它一律空串 */
function accountIdOf(entry) {
  if (typeof entry?.accountId === "string") return entry.accountId.trim()
  if (typeof entry?.accountId === "number" && Number.isFinite(entry.accountId)) return String(entry.accountId)
  return ""
}

/**
 * 读一个 JSON 文件，**不抛**。
 *
 * @param {string} file
 * @returns {{ok: true, value: *} | {ok: false, missing: boolean}}
 *   `missing` 只区分「文件不在」（ENOENT / 父路径不是目录）；坏 JSON、
 *   空文件、权限错误都是 `missing: false` —— 调用方据此给 `bad_config`。
 */
function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) }
  } catch (error) {
    const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR"
    return { ok: false, missing }
  }
}

/**
 * 从 magpie `logins.json` 的行里挑出「首选账号」那一行。
 *
 * **纯函数**：不读磁盘、不联网、不改输入。判定顺序必须与 magpie 自己的
 * 账号页一致（`Make first` 写 `first`，新增 / 拖拽写 `order`）：
 *
 *     first === true  →  最小正 order  →  第一行
 *
 * 只看 `agent === "plugin:<provider>"` 且 `home` 非空的行。
 *
 * @param {unknown} loginsRows `logins.json` 的数组（只用到 agent / home / first / order）
 * @param {string} provider 供应商标识（如 "phanthycode"），两端空白忽略
 * @returns {object|null} 原始行对象（引用相等，调用方可继续读其它字段）；
 *   没有可用行（含非数组、别的 provider、home 全空）时 `null`
 */
export function pickPreferredRow(loginsRows, provider) {
  const wanted = textOf(provider)
  if (!wanted) return null
  const rows = Array.isArray(loginsRows) ? loginsRows : []
  const agent = `plugin:${wanted}`

  // 收一遍候选：本 provider + home 非空。**不 sort / 不 splice / 不改输入**
  // （原地排序会让调用方拿到的数组顺序变掉，且并发读同一个数组时会串）。
  const live = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    if (textOf(row.agent) !== agent) continue
    if (textOf(row.home) === "") continue
    live.push(row)
  }
  if (live.length === 0) return null

  // ① `Make first` 写的显式标记；多个 true 时按原数组顺序取第一个
  const first = live.find((row) => row.first === true)
  if (first) return first

  // ② 最小正 order：只对「有限数字 / 数字字符串」做数字比较；
  //    缺失、NaN、Infinity、0、负数、布尔 / 对象等一律忽略（不是 0，也不是 1）
  let best = null
  let bestOrder = Number.POSITIVE_INFINITY
  for (const row of live) {
    const raw = row.order
    if (typeof raw !== "number" && typeof raw !== "string") continue
    const order = Number(raw)
    if (!Number.isFinite(order) || order <= 0) continue
    if (order < bestOrder) {
      best = row
      bestOrder = order
    }
  }
  if (best) return best

  // ③ 单账号 / 全是 order 0 或负数：magpie 自己也就是「第一行」
  return live[0]
}

/**
 * 从 `plugin-auth.json` 的一条记录里取稳定身份。
 *
 * 顺序与 `src/credential.mjs` 的 `uidOf()` **一致**：`metadata.userId` 优先，
 * 其次是顶层 `uid`。
 *
 * ⚠ 为什么必须回退 `entry.uid`：本机真实 `plugin-auth.json` 里 **0 条**带
 *   `metadata.userId` —— oauth 型登录态只有 `metadata.email`，稳定身份在本插件
 *   自己写的顶层 `uid`（= `fingerprint(accountScope)`）。只认 `metadata.userId`
 *   会让所有升级用户的「首选账号」静默失效（reason=no_uid），而且原因文案还是错的。
 *   `entry.accountId` / `entry.org` 仍然不采纳 —— 它们是显示名 / 宿主内部字段。
 *
 * @param {unknown} entry `plugin-auth.json` 的条目
 * @returns {string} 稳定 uid；取不到时 `""`（**不抛**）
 */
export function uidFromAuthEntry(entry) {
  if (!isRecord(entry)) return ""
  if (isRecord(entry.metadata)) {
    const fromMetadata = textOf(entry.metadata.userId)
    if (fromMetadata) return fromMetadata
  }
  return textOf(entry.uid)
}

/**
 * 读「magpie 首选账号」的稳定 uid。
 *
 * 数据来源（**只读**，非官方插件 API，magpie 改结构时必须容错）：
 *
 *     ~/.config/magpie/logins.json        agent / home / first / order
 *     ~/.config/magpie/plugin-auth.json   <home> → { metadata: { userId }, accountId }
 *
 * @param {string} provider 供应商标识（如 "phanthycode"）
 * @param {{configDir?: string, loginsFile?: string, authFile?: string}} [options]
 *   `configDir` 默认 `~/.config/magpie`；`loginsFile` / `authFile` 显式给定时
 *   直接覆盖对应文件（测试 / 集成层用）。
 * @returns {{uid: string, home: string, accountId: string, reason: string}}
 *   `reason` 取 `PREFERRED_REASONS` 的值；`accountId` 只用于展示，可能是空串。
 *   **任何输入都不抛**（读失败 / 结构变了都收敛成 `reason`）。
 */
export function readPreferredUid(provider, options = {}) {
  try {
    // ── 输入形状：非法参数不能走到 fs（join 遇到非字符串会抛） ──────────
    const wanted = textOf(provider)
    if (!wanted) return failure(PREFERRED_REASONS.badConfig)
    if (!isRecord(options)) return failure(PREFERRED_REASONS.badConfig)

    const configDir = options.configDir === undefined
      ? join(homedir(), ".config", "magpie")
      : textOf(options.configDir)
    if (!configDir) return failure(PREFERRED_REASONS.badConfig)

    const loginsFile = options.loginsFile === undefined
      ? join(configDir, "logins.json")
      : textOf(options.loginsFile)
    if (!loginsFile) return failure(PREFERRED_REASONS.badConfig)

    const authFile = options.authFile === undefined
      ? join(configDir, "plugin-auth.json")
      : textOf(options.authFile)
    if (!authFile) return failure(PREFERRED_REASONS.badConfig)

    // ── logins.json：缺失 / 坏 JSON / 非数组 ──────────────────────────
    const loginsRead = readJsonFile(loginsFile)
    if (!loginsRead.ok) {
      return failure(loginsRead.missing ? PREFERRED_REASONS.noLogins : PREFERRED_REASONS.badConfig)
    }
    const loginsRows = loginsRead.value
    if (!Array.isArray(loginsRows)) return failure(PREFERRED_REASONS.badConfig)

    // 先区分「没有本 provider 的行」与「有行但 home 全空」—— 两者的修法不同
    const agent = `plugin:${wanted}`
    const hasProviderRow = loginsRows.some((row) => isRecord(row) && textOf(row.agent) === agent)
    if (!hasProviderRow) return failure(PREFERRED_REASONS.noRow)

    const picked = pickPreferredRow(loginsRows, wanted)
    if (!picked) return failure(PREFERRED_REASONS.noHome)
    const home = textOf(picked.home)
    if (!home) return failure(PREFERRED_REASONS.noHome)

    // ── plugin-auth.json：缺失 / 坏 JSON / 非对象 / 没这个 home ───────
    const authRead = readJsonFile(authFile)
    if (!authRead.ok) {
      return failure(authRead.missing ? PREFERRED_REASONS.noAuthEntry : PREFERRED_REASONS.badConfig, home)
    }
    const auth = authRead.value
    if (!isRecord(auth)) return failure(PREFERRED_REASONS.badConfig, home)
    // 用 hasOwnProperty：home 来自文件，`__proto__` 这类键不能从原型上「借」到条目
    if (!Object.prototype.hasOwnProperty.call(auth, home)) return failure(PREFERRED_REASONS.noAuthEntry, home)

    const entry = auth[home]
    if (!isRecord(entry)) return failure(PREFERRED_REASONS.noAuthEntry, home)

    // ── 稳定身份：只认 metadata.userId ────────────────────────────────
    const accountId = accountIdOf(entry)
    const uid = uidFromAuthEntry(entry)
    if (!uid) return failure(PREFERRED_REASONS.noUid, home, accountId)

    return { uid, home, accountId, reason: PREFERRED_REASONS.ok }
  } catch {
    // 宿主目录只读、结构随时可能变；抛出去 = 插件在宿主里起不来
    return failure(PREFERRED_REASONS.badConfig)
  }
}
