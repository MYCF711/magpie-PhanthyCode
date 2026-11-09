// src/invite-source.mjs —— 邀请源策略 + 本地缓存（「谁的邀请链接可以用」与「每个账号的码放哪」）
//
// ═══════════════════════════════════════════════════════════════════
// 这个模块要回答的两个问题
// ═══════════════════════════════════════════════════════════════════
//
//   ① 这次注册该挂到**谁**名下（`resolve`，纯本地、零网络、零宿主文件读取）
//   ② 每个账号自己的邀请码**存哪、怎么不串号**（`createInviteSourceStore`）
//
// 目标语义（`invite_mode` 开关，开关本身在 index 里声明，不在这里）：
//
//   off（默认）= 自动：用**最新首次见到**的那个账号的码；
//                       最新那个还没码 → 往前找上一个有码且没被判死的账号；
//                       一个都没有 → 用户的**预留码**；再没有 → 空（裸登录）。
//   on        = 首选：只用 magpie 账号页「首选」那个账号的码（`preferredUid` 由外部传入）；
//                       首选没码 / 死号 / 首选未知 → **只回预留码**，绝不静默换别的账号。
//
// ⚠ 为什么 off 的「最新」= **本模块第一次见到这个账号的时刻**，而不是「最后登录时间」：
//   重登一个旧号会把「最新」抢走，下一次注册就挂到旧号名下 —— 上级奖励给错人，
//   而且**界面一切正常、没有任何报错**。所以 `firstSeenAt` 只写一次（见 `noteAccount`）。
//
// ⚠ 为什么预留码必须单独一个文件、本模块**永不写它**：
//   自动派生出来的是「本机现在最合适的那个号的码」，会随账号增减而变；用户自己填的那条
//   是**链尾兜底**。两者混在一个文件里，一次自动派生就把兜底覆盖掉，而且用户看不出
//   （下一次登录只是「邀请没生效」）。预留值仍由 `src/invite.mjs` 的 `createInviteStore`
//   写 `<prefix>-invite.json`；本模块只**读**调用方传进来的 `reservedCode`。
//
// ═══════════════════════════════════════════════════════════════════
// 边界（这几条都是「写错不报错」的类型，改代码前先读）
// ═══════════════════════════════════════════════════════════════════
//
//   ① 只写 `~/.cache/magpie`（`src/store.mjs` 规矩 ①）。`logins.json` /
//      `plugin-auth.json` 是 magpie 的目录，**一律只读**；而且首选账号的解析
//      （`preferredHome`）是本模块提供的**纯函数** —— 读宿主文件是集成层的事。
//   ② 键只能是 uid（= `metadata.userId` = `fingerprint(accountScope)` 那条稳定身份），
//      **绝不用 `accountId`**：它是显示名（打码手机号/昵称），可重名、可改名、重登会变。
//   ③ 每账号一个文件（`<prefix>-invite-code-<key>.json`），文件名里不带 `:` `/` 与原 uid；
//      uid 不安全时用 `sha256(uid).slice(0,24)`（同一 uid 永远映射到同一个文件名）。
//   ④ 缓存里**不存** token / refresh / authorization / `referralState`。写入口只认白名单字段，
//      多传的键一律丢掉（不是「存下来但不用」，是根本不落盘）。
//   ⑤ 所有读失败（文件不在、坏 JSON、坏码）一律当「没有」，**不抛**；写失败不影响主流程。
//      `writeJson` 自带独立临时名 + 0600 + 原子 rename（`src/store.mjs`）。
//   ⑥ 码白名单 `^[A-Za-z0-9._-]{1,200}$`（与 `src/invite.mjs` 的 `referralShareUrl`、
//      `src/referrals.mjs` 的 `REFERRAL_CODE_RE` 同一口径，**形状只判这一次**）。
//      另外挡住两类「形状对但不能用」的东西：
//        · `referral_state`（`rs1.…`）—— 按链接即时签发的短期令牌，不是邀请码。
//        · 凭据形状（JWT / `di_…` 安装 id / `Bearer …` / `sk-…`）—— 一律不当作邀请码。
//      人类可读的短 `invite_code` **不再按形状拒绝**：上游取码接口回的码形状不保证，
//      两层判定分叉会变成「采集成功但磁盘上没有码」的静默失效（见 INVITE_CODE_RE 注释）。

import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

import { BASE } from "./context.mjs"
import { referralShareUrl } from "./invite.mjs"
import { assertTrustedUrl } from "./origin.mjs"
import { readJson, removeJson, writeJson } from "./store.mjs"

/**
 * 邀请码形状。
 *
 * ⚠ **只有这一层判定**：码的形状必须与 `src/referrals.mjs`（`REFERRAL_CODE_RE`）和
 *   `src/invite.mjs` 的 `referralShareUrl` 同一口径。曾经这里额外拒绝「短 `invite_code`」
 *   （`^[A-Za-z0-9]{2,6}(?:-[A-Za-z0-9]{2,6}){2,}$`），结果上游取码接口回一张
 *   `AB12-CD34-EF56` 形状的码时：`referrals` 收下、`/r/<code>` 也拼得出来，
 *   但 `saveCode()` 悄悄返回 null —— 采集记为成功、磁盘上什么都没有，自动模式报
 *   「没有任何账号的邀请链接」。**形状只判一次**，判不了就交给 `/r/` 的真实结果。
 */
export const INVITE_CODE_RE = /^[A-Za-z0-9._-]{1,200}$/

/**
 * 失败 / 兜底的 `reason` 词表。
 *
 * ⚠ 这些**不是** HTTP 错误码（那套在 `src/http.mjs` 的 `CODES` / `ERROR-CODES.md` §3）：
 * 它们只回答「为什么这次没拿到一个可用的邀请码」，不进响应体、不参与宿主的重试/换号判断，
 * 只给展示层与排查用。集中在这里是为了让调用方不必猜字符串（也避免各处自己编词）。
 */
export const SOURCE_REASONS = Object.freeze({
  /** 空 / 非字符串输入 */
  empty: "empty",
  /** 别的 origin（含 `//host`、userinfo、非默认端口） */
  untrustedOrigin: "untrusted_origin",
  /** 非 https（`http:` / `javascript:` / `data:` …） */
  untrustedScheme: "untrusted_scheme",
  /** 人类可读短码：只能注册页手填，塞进 `/r/` 只会 404 */
  shortInviteCode: "short_invite_code",
  /** `rs1.…` / JWT / `di_…` / `Bearer …` / `sk-…`：是凭据或状态令牌，不是邀请码 */
  credential: "credential",
  /** 路径不是 `/r/<code>`、非白名单字符、超长、退化输入 */
  invalidCode: "invalid_code",
  /** 首选模式：调用方没给首选 uid */
  preferredMissing: "preferred_missing",
  /** 首选模式：首选账号资格被否（死号） */
  preferredIneligible: "preferred_ineligible",
  /** 首选模式：首选账号还没有码 */
  preferredNoCode: "preferred_no_code",
  /** 自动模式：没有任何账号有可用码 */
  noAccountCode: "no_account_code",
  /** 兜底的预留值也不可用 */
  reservedUnusable: "reserved_unusable",
})

/** 内部短名（只在本模块用） */
const R = SOURCE_REASONS

/** 默认前缀：插件短名，避免与别的插件抢文件 */
const DEFAULT_PREFIX = "phanthycode"

/** 前缀只许这三种字符，且短：它会进文件名，不能带 `/` `\` `:` */
const PREFIX_RE = /^[A-Za-z0-9._-]{1,40}$/

/** `/r/<code>`（可省前导 `/`，容忍尾斜杠；query / hash 在匹配前已切掉） */
const SHARE_PATH_RE = /^\/?r\/([^/?#]+)\/?$/i

/** 凭据 / 状态令牌形状：即使过了字符白名单，也绝不当作邀请码 */
const CREDENTIAL_RES = [
  /^rs1\./i, // referral_state
  /^di_[A-Za-z0-9_-]+$/i, // 设备 installationId
  /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
  /^(?:bearer|basic|token|jwt)\s/i,
  /^(?:sk|pk|rk|ghp|gho|ghs|xox[baprs])[-_]/i,
]

/** 每个 uid 的文件名键：安全的原样用，其余的取 sha256 前 24 位 */
function safeKeyOf(uid) {
  const key = textOf(uid)
  if (!key) return ""
  if (/^[A-Za-z0-9_-]{1,64}$/.test(key)) return key
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 24)
}

function textOf(value) {
  return typeof value === "string" ? value.trim() : ""
}

/** 时间戳：接受毫秒数 / Date，非法值按「现在」（缓存写失败也不该让主流程炸） */
function timeOf(value) {
  if (value instanceof Date) {
    const t = value.getTime()
    return Number.isFinite(t) ? Math.trunc(t) : Date.now()
  }
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : Date.now()
}

function stampOrZero(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/** slot 只认正整数（协议一次给 5 个，slot 是 1..5）；其余存 null，不编 */
function slotOf(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function cacheDirectory() {
  return join(homedir(), ".cache", "magpie")
}

/** 由 code 派生分享链接（同 origin 闸门在 `referralShareUrl` 里；不合法就空串） */
function shareUrlOf(code) {
  try {
    return referralShareUrl(BASE, code)
  } catch {
    return ""
  }
}

function reject(reason) {
  return { ok: false, code: "", form: "", shareUrl: "", reason }
}

/** code 本身的问题（空 / 短码 / 凭据 / 非白名单）；返回空串表示可用 */
function problemOf(code) {
  if (!code) return R.empty
  for (const re of CREDENTIAL_RES) if (re.test(code)) return R.credential
  if (!INVITE_CODE_RE.test(code)) return R.invalidCode
  // `...` / `---` 这类退化输入也在白名单字符集里，但它们不可能是码
  if (!/[A-Za-z0-9]/.test(code)) return R.invalidCode
  return ""
}

/**
 * 解析用户 / 上游给的邀请码。**从不抛**，失败用 `reason` 分类。
 *
 * 接受的形态（都归一成同一个 `code`）：
 *   · 官方完整链接 `https://code.phanthy.com/r/<code>`（query / hash 忽略）
 *   · 相对路径 `/r/<code>`（可省前导 `/`）
 *   · 裸长码 `<code>`
 *
 * 拒绝的形态与原因：
 *   · `empty`             空 / 非字符串
 *   · `untrusted_origin`  别的 origin、`//host`、带 userinfo、非默认端口
 *   · `untrusted_scheme`  非 https（`http:` / `javascript:` / `data:` …）
 *   · `short_invite_code` 人类可读短码（只能注册页手填，不能造 `/r/` 链接）
 *   · `credential`        `rs1.…` / JWT / `di_…` / `Bearer …` / `sk-…`
 *   · `invalid_code`      路径不是 `/r/<code>`、非白名单字符、超长、退化输入
 *
 * @param {string} input
 * @returns {{ok: boolean, code: string, form: ""|"url"|"path"|"bare", shareUrl: string, reason: string}}
 */
export function parseInviteShareCode(input) {
  const raw = textOf(input)
  if (!raw) return reject(R.empty)

  // 凭据 / state：先按原文挡掉（`Bearer x` 这类含空格，白名单也会拒，但原因要说清）
  for (const re of CREDENTIAL_RES) if (re.test(raw)) return reject(R.credential)

  const looksAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(raw)
  const looksProtocolRelative = raw.startsWith("//")

  if (looksProtocolRelative) {
    // `//host/x` 是协议相对的绝对 URL，不是相对路径
    return reject(R.untrustedOrigin)
  }

  let code = ""
  let form = "bare"

  if (looksAbsolute) {
    let url
    try {
      url = assertTrustedUrl(raw)
    } catch (err) {
      return reject(err?.reason === "protocol" ? R.untrustedScheme : R.untrustedOrigin)
    }
    // 只看 pathname：`?from=share` / `#x` 不影响 code
    const m = SHARE_PATH_RE.exec(url.pathname)
    if (!m) return reject(R.invalidCode)
    code = m[1]
    form = "url"
  } else {
    // 相对路径形态（`/r/<code>`、`r/<code>`）；切掉 query / hash 再匹配
    const cut = raw.split("#")[0].split("?")[0]
    const m = SHARE_PATH_RE.exec(cut)
    if (m) {
      code = m[1]
      form = "path"
    } else if (/^\/?r\//i.test(cut)) {
      // `/r/` 后为空，或 `/r/a/b`、`/r/%2F` 这种 —— 直接拒，不做「猜一个」
      return reject(R.invalidCode)
    } else {
      code = raw
      form = "bare"
    }
  }

  const problem = problemOf(code)
  if (problem) return reject(problem === R.empty ? R.invalidCode : problem)

  return { ok: true, code, form, shareUrl: shareUrlOf(code), reason: "" }
}

/**
 * 「首选账号」是哪个 —— 从 magpie `logins.json` 的行里挑。
 *
 * **纯函数**：不读磁盘、不写、不联网。集成层负责读文件（那是宿主目录，只读），
 * 这里只负责判定顺序，且顺序必须与 magpie 自己的语义一致：
 *
 *   `first === true`  →  最小**正** `order`  →  第一行
 *
 * 只看 `agent === "plugin:<provider>"` 且 `home` 非空的行（别的 provider 的行、空 home 不算）。
 * 读不到 / 结构变了 / 没这个 provider → 空串（= 首选未知，调用方回退预留码，**不静默换人**）。
 *
 * @param {unknown} loginsRows `logins.json` 的数组（只用到 agent / home / first / order）
 * @param {string} provider 供应商标识，如 "phanthycode"
 * @returns {string} home（可再进 `plugin-auth.json` 取 uid）；没有则 ""
 */
export function preferredHome(loginsRows, provider) {
  const rows = Array.isArray(loginsRows) ? loginsRows : []
  const wanted = `plugin:${textOf(provider)}`
  if (wanted === "plugin:") return ""

  const live = rows.filter((row) => {
    if (!row || typeof row !== "object") return false
    if (textOf(row.agent) !== wanted) return false
    return Boolean(textOf(row.home))
  })
  if (live.length === 0) return ""

  const first = live.find((row) => row.first === true)
  if (first) return textOf(first.home)

  const ordered = live
    .filter((row) => {
      const order = Number(row.order)
      return Number.isFinite(order) && order > 0
    })
    .sort((a, b) => Number(a.order) - Number(b.order))
  if (ordered.length > 0) return textOf(ordered[0].home)

  // 单账号 / 全是 order 0 或负数：magpie 自己也就是「第一行」
  return textOf(live[0].home)
}

/**
 * 邀请源存储。只写 `~/.cache/magpie`，两套文件：
 *
 *   `<prefix>-invite-accounts.json`        uid → {accountScope, accountId, firstSeenAt,
 *                                                 lastSeenAt, eligible?, reason?}
 *   `<prefix>-invite-code-<key>.json`      每个 uid 一个：{uid, code, shareUrl, slot, at}
 *
 * 索引里**只放身份与时间**，不放码（码按 uid 分开，换账号绝不会串）。
 * 预留值（用户手填那条）不在这里：仍是 `src/invite.mjs` 的 `<prefix>-invite.json`，
 * 本模块只读调用方传进来的值，**永不写它**。
 *
 * @param {string} [prefix] 插件短名；非法字符回退默认值（它要进文件名）
 */
export function createInviteSourceStore(prefix = DEFAULT_PREFIX) {
  const rawPrefix = textOf(prefix)
  const p = PREFIX_RE.test(rawPrefix) ? rawPrefix : DEFAULT_PREFIX
  const dir = cacheDirectory()
  const indexFile = join(dir, `${p}-invite-accounts.json`)

  function codeFile(uid) {
    const key = safeKeyOf(uid)
    return key ? join(dir, `${p}-invite-code-${key}.json`) : ""
  }

  // ── 账号索引 ──────────────────────────────────────────────────────

  /** 读索引：坏文件 / 坏形状一律当空表。兼容 `{accounts:{…}}` 包装（向前兼容）。 */
  function readAccounts() {
    const value = readJson(indexFile, null)
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const source =
      value.accounts && typeof value.accounts === "object" && !Array.isArray(value.accounts) ? value.accounts : value
    const out = {}
    for (const [uid, entry] of Object.entries(source)) {
      const key = textOf(uid)
      if (!key || !entry || typeof entry !== "object") continue
      const item = {
        accountScope: textOf(entry.accountScope),
        accountId: textOf(entry.accountId),
        firstSeenAt: stampOrZero(entry.firstSeenAt),
        lastSeenAt: stampOrZero(entry.lastSeenAt),
      }
      if (typeof entry.eligible === "boolean") item.eligible = entry.eligible
      const reason = textOf(entry.reason)
      if (reason) item.reason = reason
      // 采集冷却：**落盘**，不能只放进程内存 —— 重启一次就忘了，
      // 「每账号 24h 至多一次」就成了「每进程至多一次」。
      // 没有尝试过就**不写这个键**（`markEligibility` 会 `{...prev}` 回写，
      // 凭空造一个 0 会把「白名单字段」污染成 `attemptedAt: 0`）。
      const attemptedAt = stampOrZero(entry.attemptedAt)
      if (attemptedAt) item.attemptedAt = attemptedAt
      const attemptReason = textOf(entry.attemptReason)
      if (attemptReason) item.attemptReason = attemptReason
      out[key] = item
    }
    return out
  }

  function readAccount(uid) {
    const key = textOf(uid)
    if (!key) return null
    return readAccounts()[key] ?? null
  }

  /**
   * 记一次「本机见到这个账号」。**`firstSeenAt` 只写一次**。
   *
   * 重登旧号（时间更晚、甚至改了显示名）只更新 `lastSeenAt` / `accountId`，
   * 不许动 `firstSeenAt` —— 否则旧号会把「最新」抢走，下一次注册就挂到旧号名下。
   * `eligible` / `reason` 由 `markEligibility` 管，这里不覆盖。
   *
   * @returns {{uid: string, accountScope: string, accountId: string, firstSeenAt: number, lastSeenAt: number} | null}
   */
  function noteAccount({ uid, accountScope, accountId, at } = {}) {
    const key = textOf(uid)
    if (!key) return null

    const when = timeOf(at)
    const accounts = readAccounts()
    const prev = accounts[key] ?? null

    const entry = {
      accountScope: textOf(accountScope) || prev?.accountScope || "",
      accountId: textOf(accountId) || prev?.accountId || "",
      firstSeenAt: prev && prev.firstSeenAt > 0 ? prev.firstSeenAt : when,
      lastSeenAt: Math.max(prev?.lastSeenAt ?? 0, when),
    }
    if (prev && typeof prev.eligible === "boolean") entry.eligible = prev.eligible
    if (prev?.reason) entry.reason = prev.reason
    if (prev?.attemptedAt) entry.attemptedAt = prev.attemptedAt
    if (prev?.attemptReason) entry.attemptReason = prev.attemptReason

    accounts[key] = entry
    writeJson(indexFile, accounts) // 写失败不影响主流程（规矩 ⑤）
    return { uid: key, ...entry }
  }

  /**
   * 记资格（`eligible_to_invite`）。只给**已经见过**的账号记 —— 不凭空造账号，
   * 也不改 `firstSeenAt` / `lastSeenAt`（资格不是一次登录）。
   * `eligible` 只认布尔（其它值不改变已有结论）；`reason` 传空串表示清空。
   *
   * @returns {object | null} 更新后的条目；账号没见过的 uid 返回 null
   */
  function markEligibility({ uid, eligible, reason } = {}) {
    const key = textOf(uid)
    if (!key) return null

    const accounts = readAccounts()
    const prev = accounts[key]
    if (!prev) return null

    const next = { ...prev }
    if (typeof eligible === "boolean") next.eligible = eligible
    if (typeof reason === "string") {
      const text = reason.trim()
      if (text) next.reason = text
      else delete next.reason
    }

    accounts[key] = next
    writeJson(indexFile, accounts)
    return { uid: key, ...next }
  }

  /**
   * 记一次「采集尝试」（时间 + 原因），**落盘**。
   *
   * 为什么要落盘：`POST /referrals/code` 是写面（会消耗名额），冷却只放进程内存的话，
   * 用户每重启一次 magpie 就能再打一次。另外幂等键要按同一个窗口固定，
   * 调用方需要读回上次的 `attemptedAt` 来复用。
   *
   * @returns {object | null} 更新后的条目；账号没见过的 uid 返回 null
   */
  function markAttempt({ uid, at, reason } = {}) {
    const key = textOf(uid)
    if (!key) return null

    const accounts = readAccounts()
    const prev = accounts[key]
    if (!prev) return null

    const next = { ...prev, attemptedAt: timeOf(at) }
    const text = textOf(reason)
    if (text) next.attemptReason = text
    else delete next.attemptReason

    accounts[key] = next
    writeJson(indexFile, accounts)
    return { uid: key, ...next }
  }

  /**
   * 把这个账号的码判死（删掉码文件）。
   *
   * 触发点：`/r/<code>` 明确回 404/410（分享页已经不存在）。不清掉的话，
   * 它会一直占着「最新账号」这一格，每次登录都拿一张死码去换 state ——
   * 邀请永远不生效，而且没有任何报错。
   *
   * @returns {boolean} 真的删掉了才返回 true
   */
  function dropCode(uid) {
    const key = textOf(uid)
    if (!key) return false
    const file = codeFile(key)
    if (!file) return false
    // 「真的删掉了才 true」：removeJson 对不存在的文件也返回成功，先读一次再删。
    if (readJson(file, null) === null) return false
    removeJson(file)
    return true
  }

  // ── 每账号的码 ────────────────────────────────────────────────────

  /**
   * 读某账号的码。**任何异常都当没有**：文件不在 / 坏 JSON / 坏码 → null。
   * 返回的 `shareUrl` 一律是按 code 派生的规范形态（跨 origin 的 URL 从不落盘、也从不返回）。
   *
   * @returns {{uid: string, code: string, shareUrl: string, slot: number|null, at: number} | null}
   */
  function readCode(uid) {
    const key = textOf(uid)
    if (!key) return null
    const file = codeFile(key)
    if (!file) return null

    const value = readJson(file, null)
    if (!value || typeof value !== "object") return null
    const code = textOf(value.code)
    if (problemOf(code)) return null

    return {
      uid: key,
      code,
      shareUrl: shareUrlOf(code),
      slot: slotOf(value.slot),
      at: stampOrZero(value.at),
    }
  }

  /**
   * 存某账号的码。**空码 / 非法码 / 短码一律不写**（绝不覆盖已有的好码）。
   *
   * `shareUrl` 只做交叉校验：同 origin 且 code 一致才采用（结果仍是规范化形态），
   * 其余（跨 origin、非 https、code 对不上）直接丢弃、改用 code 派生 ——
   * 所以文件里**不可能**出现外部 URL。
   *
   * @returns {{uid: string, code: string, shareUrl: string, slot: number|null, at: number} | null}
   */
  function saveCode({ uid, code, shareUrl, slot, at } = {}) {
    const key = textOf(uid)
    if (!key) return null

    const parsed = parseInviteShareCode(code)
    if (!parsed.ok) return null // 空码 / 短码 / 凭据 / 非法码：什么都不写

    let share = ""
    if (typeof shareUrl === "string" && shareUrl.trim()) {
      const cross = parseInviteShareCode(shareUrl)
      if (cross.ok && cross.code === parsed.code) share = cross.shareUrl
    }
    if (!share) share = parsed.shareUrl

    const entry = { uid: key, code: parsed.code, shareUrl: share, slot: slotOf(slot), at: timeOf(at) }
    const file = codeFile(key)
    if (!file) return null
    writeJson(file, entry)
    return entry
  }

  // ── 选择算法 ──────────────────────────────────────────────────────

  /** 预留值归一化（完整链接 / `/r/` 路径 / 裸码都可以）；不可用就记原因 */
  function reservedOf(reservedCode) {
    const parsed = parseInviteShareCode(reservedCode)
    if (parsed.ok) return { ok: true, code: parsed.code, shareUrl: parsed.shareUrl, reason: "" }
    return { ok: false, code: "", shareUrl: "", reason: parsed.reason }
  }

  /**
   * 兜底：有预留码就用预留码（`reason` 记下为什么落到这里），没有就给空。
   *
   * `reason` 词表（只用于展示/排查，不参与判断）：
   *   preferred_missing / preferred_ineligible / preferred_no_code /
   *   no_account_code   —— 落 reserved 时说明「为什么不是某个账号的码」
   *   reserved_unusable —— 预留值也不可用（短码 / 跨 origin / 非法）
   */
  function fallback(cause, reserved) {
    if (reserved.ok) {
      return {
        code: reserved.code,
        shareUrl: reserved.shareUrl,
        kind: "reserved",
        uid: "",
        accountScope: "",
        accountId: "",
        reason: cause,
      }
    }
    return {
      code: "",
      shareUrl: "",
      kind: "none",
      uid: "",
      accountScope: "",
      accountId: "",
      reason: reserved.reason === R.empty ? cause : R.reservedUnusable,
    }
  }

  /**
   * 这次注册该用哪个邀请码。**纯本地**：只读本模块自己的缓存，零网络、零宿主文件。
   *
   *   on（`preferFirst === true`）：首选账号的码 → 没有就 reserved（**不换别的账号**）
   *   off                      ：最新（`firstSeenAt` 降序）里第一个「有码且 eligible !== false」
   *                              → 再没有就 reserved
   *
   * 返回形状固定，`kind` 是唯一判据：
   *   `{code, shareUrl, kind: "latest"|"preferred"|"reserved"|"none", uid, accountScope, accountId, reason}`
   *   `kind === "none"` 时 `code` 是空串（调用方走裸登录），**不抛**。
   *
   * @param {{preferFirst?: boolean, preferredUid?: string, reservedCode?: string}} [o]
   */
  function resolve({ preferFirst = false, preferredUid = "", reservedCode = "" } = {}) {
    const accounts = readAccounts()
    const reserved = reservedOf(reservedCode)

    if (preferFirst === true) {
      const key = textOf(preferredUid)
      if (!key) return fallback(R.preferredMissing, reserved)

      const entry = accounts[key] ?? null
      // 死号（资格被否）不提供码：不静默换别的账号
      if (entry && entry.eligible === false) return fallback(R.preferredIneligible, reserved)

      const mine = readCode(key)
      if (!mine) return fallback(R.preferredNoCode, reserved)

      return {
        code: mine.code,
        shareUrl: mine.shareUrl,
        kind: "preferred",
        uid: key,
        accountScope: entry?.accountScope ?? "",
        accountId: entry?.accountId ?? "",
        reason: "",
      }
    }

    // off：最新首次见到的优先；它没码（或判死）就往前退一个，绝不「不带邀请」
    const ordered = Object.entries(accounts)
      .map(([uid, entry]) => ({ uid, ...entry }))
      .sort(
        (a, b) =>
          b.firstSeenAt - a.firstSeenAt ||
          b.lastSeenAt - a.lastSeenAt ||
          (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0),
      )

    for (const entry of ordered) {
      if (entry.eligible === false) continue
      const mine = readCode(entry.uid)
      if (!mine) continue
      return {
        code: mine.code,
        shareUrl: mine.shareUrl,
        kind: "latest",
        uid: entry.uid,
        accountScope: entry.accountScope,
        accountId: entry.accountId,
        reason: "",
      }
    }

    return fallback(R.noAccountCode, reserved)
  }

  return {
    // 诊断用（测试与报告要能指出到底写了哪两个文件）
    prefix: p,
    dir,
    indexFile,
    codeFile,
    // 账号索引
    readAccounts,
    readAccount,
    noteAccount,
    markEligibility,
    markAttempt,
    // 每账号的码
    readCode,
    saveCode,
    dropCode,
    // 选择
    resolve,
  }
}
