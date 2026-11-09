// src/device-key.mjs —— 本机设备身份（三把 ed25519 密钥 + 安装记录）
//
// 这个插件**不使用**任何已存在的设备会话：密钥由本插件自己生成，安装记录按账号
// 隔离存在插件自己的缓存目录里（`~/.cache/magpie/phanthycode-device-…json`）。
//
// ── 三把密钥（2026-11-09 真机实测：三把互不相同，缺一条就 400/409）─────────
//
//   identity   公钥进 body.public_key + device canonical 第 4 段；**x-desktop-* 头签名**
//              用它签。installationId 只由 identity 公钥派生（见 installation-id.mjs）。
//   device     body.device_public_key；**body.device_signature** 用它签。
//              早先 `deviceKeyDistinct:false` 把它等同于 identity，是错的。
//   inference  body.inference_public_key；**/v1/messages 的 12 段推理证明**用它签。
//              它是 sidecar 的会话密钥：**每次注册现生成**，不跨重启固定。
//
// 持久化边界（重启实验实证）：identity / device 跨重启**不变**；inference 每次变。
// 所以 identity + device 一旦生成就不再动（动一次 = 换设备 = 换 installationId），
// inference 在每次注册时由 {@link renewInferenceKey} 换新。
//
// 三条存储规矩（与 `src/store.mjs` 一致，缺一条就会出事）：
//   ① 只写 `~/.cache/magpie`，不碰 magpie 自己的 `~/.config/magpie`；
//   ② 文件名带账号指纹 —— 宿主是同一个进程跑所有账号，单文件存会串号；
//   ③ 缓存可删：删掉只是「重新注册一次设备」，不能变成崩溃。
//
// ⚠ 私钥落盘是本模块唯一的敏感物：文件权限按 0600 写，Windows 上 chmod 对 NTFS
//   ACL 是空操作，实际保护来自用户目录本身的权限。这里不引入 keychain 依赖，
//   也不把私钥写进任何日志/错误信息/包内文件。
//
// ⚠ 这里不存 token。access/refresh 归 magpie 的 auth 存储，`desktop_inference_token`
//   只在内存或安装记录里各存一份，且不参与日志。

import { createPublicKey } from "node:crypto"
import { chmodSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

import { ApiError } from "./api.mjs"
import { PROVIDER } from "./context.mjs"
import { CODES } from "./http.mjs"
import { installationIdFromPublicKey } from "./installation-id.mjs"
import {
  exportPrivateKey,
  generateEd25519KeyPair,
  importPrivateKey,
  importPublicKey,
  spkiB64Url,
} from "./proof.mjs"
import { fileOf, readJson, removeJson, writeJson } from "./store.mjs"

/** `fileOf` 的目录（按 accountScope 扫描时要用） */
function cacheDirOf() {
  return join(homedir(), ".cache", "magpie")
}

/** 缓存文件种类 —— 前缀由 store.mjs 的 PREFIX 决定 */
const KIND = "device"

/** 安装记录的结构版本；读到时版本不符按「没有记录」处理 */
export const RECORD_SCHEMA_VERSION = 1

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} 必须是非空字符串`)
  }
  return value
}

/** 安装记录文件路径（按账号隔离） */
export function installationFile(account) {
  return fileOf(KIND, { siteId: PROVIDER, account: requiredString(String(account ?? ""), "installationFile: account") })
}

/**
 * 读安装记录。文件不在、JSON 坏了、版本不符 —— 一律返回 null（规矩 ③）。
 *
 * 只校验 identity 那对密钥：0.2.3 及更早的记录没有 device / inference 密钥，
 * 它们由 {@link ensureKeyMaterial} 就地补齐，不能因此把整条记录当成不存在
 * （那样会换掉 identity 公钥 ⇒ 换掉 installationId）。
 */
export function readInstallation(account) {
  if (!account) return null
  const value = readJson(installationFile(account), null)
  if (!value || typeof value !== "object") return null
  if (value.schemaVersion !== RECORD_SCHEMA_VERSION) return null
  if (!value.installationId || !value.publicKey || !value.privateKey) return null
  return value
}

/**
 * 按 `accountScope` 找安装记录（不按键找）。
 *
 * 为什么需要：记录键是 `uidOf(auth)`，而它优先用 `auth.uid` —— 续期钩子会把
 * uid 从「凭据指纹」迁到「`fingerprint(accountScope)`」（稳定锚点）。
 * 迁移之后**旧键下的记录还在**，新键下没有，于是只按键找的调用方（签到）会
 * 得到「未注册设备」，而推理面明明能用（真机：签到报错、推理 200）。
 *
 * 扫一遍目录成本可忽略（每账号一个文件），换来的是「换过几次 token 也不会丢身份」。
 * 找不到返回 null。
 */
export function findInstallationByScope(scope) {
  const wanted = String(scope ?? "").trim()
  if (!wanted) return null
  const hit = scanInstallations().find(({ value }) => matchesScope(value, wanted))
  return hit ? hit.value : null
}

/**
 * 扫一遍本插件的安装记录：`{ file, value }[]`（目录不可读时返回空数组）。
 *
 * ⚠ 前缀不能引用 `PREFIX` —— 那是 `store.mjs` 里的**私有**常量，这里没导入。
 *   早期版本直接写 `${PREFIX}` 会抛 ReferenceError，被 catch 吞掉，函数永远返回 null
 *   （真机：签到报「未注册设备」，而记录明明在）。从 `fileOf` 反推前缀，
 *   两边只剩一处定义。
 */
function scanInstallations() {
  const dir = cacheDirOf()
  let names = []
  try {
    const sample = basename(fileOf(KIND, { siteId: PROVIDER, account: "__x__" }))
    const prefix = sample.slice(0, sample.indexOf("__"))
    names = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const file = join(dir, name)
    const value = readJson(file, null)
    if (!value || typeof value !== "object") continue
    out.push({ file, value })
  }
  return out
}

/**
 * 这条记录能不能算「同一账号的设备」。
 *
 * 判据是 **accountScope 完全相等 + identity 那一对可用**：installationId 由 identity
 * 公钥派生，「同一台设备」的锚点只有它。device / inference **不在**判据里 ——
 * 0.2.3 的记录本来就没有它们（`readInstallation` 的注释也这么写），它们由
 * {@link ensureKeyMaterial} 在迁移时补齐；把它们写进判据只会让旧记录被当成
 * 「不存在」，从而重新注册一台设备（identity 公钥一变，服务端看到的就是另一台）。
 */
function matchesScope(value, scope) {
  return (
    String(value?.accountScope ?? "") === scope &&
    Boolean(value?.installationId) &&
    Boolean(value?.publicKey) &&
    Boolean(value?.privateKey)
  )
}

/**
 * 按 `accountScope` 找回这个账号**已经注册过**的设备，并迁移到当前账号键下。
 *
 * 为什么必须迁移而不是「再建一条」：记录键是 `uidOf(auth)`，而它会变 ——
 *   · 旧版 api 登录不写 `metadata.userId` ⇒ uid 回退成「凭据指纹」，换 token 就换键；
 *   · 新版登录写 `metadata.userId = fingerprint(accountScope)` ⇒ 键变成作用域指纹。
 * 键变了但设备只有一台：identity 公钥与 installationId 都不许动，否则服务端看到的
 * 就是另一台设备（重复注册 / 409）。所以这里把旧键下的记录**搬**到新键，
 * 旧文件清掉（幂等，找不到返回 null）。
 *
 * ⚠ 搬过去之前**必须先规范化**（M-1）：0.2.3 的记录只有 identity 那一对，
 *   device / inference 是后来才拆出来的。原样搬的话，`registeredAt` 会让注册那一步
 *   被跳过，而第一次 `requestInferenceToken` 又因为缺 inference 公钥直接回 409
 *   —— 一条**没发任何请求**的假错误，第二次才靠 `ensureKeyMaterial` 自愈。
 *   `ensureKeyMaterial` 只补缺的：identity 公钥 / 私钥、`registeredAt` 都不动。
 *
 * 边界：作用域必须**完全相等** —— 两个同名账号的 scope 不同，绝不会互相复用；
 * 也不会复制/共用另一个账号的私钥。
 *
 * 只有「已注册」或「处于 409 熔断期」的记录值得复用：半条未注册记录换键重来没有意义。
 *
 * @param {string} account 当前账号键（`uidOf(auth)`）
 * @param {string} scope `account.uuid` 原字符串
 * @returns {object|null} 迁移后（三把密钥齐全、可直接签名）的记录
 */
export function adoptInstallationByScope(account, scope) {
  const key = String(account ?? "").trim()
  const wanted = String(scope ?? "").trim()
  if (!key || !wanted) return null
  const target = installationFile(key)
  const candidates = scanInstallations().filter(
    ({ value }) =>
      matchesScope(value, wanted) && (Boolean(value.registeredAt) || Boolean(value.registrationUnavailableAt)),
  )
  if (candidates.length === 0) return null
  // 已注册的优先于「只剩熔断状态」的
  candidates.sort((a, b) => Number(Boolean(b.value.registeredAt)) - Number(Boolean(a.value.registeredAt)))
  const hit = candidates[0]
  // 先规范化再落盘：补 device / inference（旧记录没有），把非派生的 id 纠正成
  // 「identity 公钥派生值」（0.2.3 的 id 是 accountScope 哈希，拿它签名服务端只回 409）
  const { record: normalized } = normalizedKeyMaterial({ ...hit.value, account: key })
  if (hit.file === target) {
    // 同键早退也不能把 identity-only 的旧记录原样返回（F-E / M-1）：
    // ensureInstallation 会在确有变化时规范化并落盘，没变化则零写入。
    return ensureInstallation({ account: key }).record
  }
  const adopted = saveInstallation(key, normalized)
  // ⚠ 只有新记录**真的落盘**了才删旧文件（L-3）：写失败（磁盘满 / 权限 /
  //   序列化）时 `saveInstallation` 直接抛，这里再按「读回来的就是这一台设备」
  //   确认一次 —— 只判「目标文件存在」是不够的：目标键**原本就有旧文件**时那条
  //   判据恒真，于是会删掉源记录、再把一条没落盘的记录当结果返回（设备身份丢失，
  //   下次会重新注册一台）。
  const written = readJson(target, null)
  if (!written || written.installationId !== adopted.installationId || written.publicKey !== adopted.publicKey) {
    throw new ApiError(
      `设备记录迁移后没有落盘：${target}（原记录保留在 ${hit.file}，未被删除）`,
      { status: 502, code: CODES.internalError },
    )
  }
  try {
    removeJson(hit.file)
  } catch {
    // 删不掉旧文件不影响复用（只是磁盘上多一条）；不抛
  }
  return adopted
}

/**
 * 删一条安装记录（迁移用）。
 *
 * 为什么需要：`uidOf()` 在 api 型凭据上会回退到「凭据指纹」，而 access token
 * 每约 30 分钟刷新一次 —— 不迁移的话每刷新一次就多一条孤儿记录。迁移到稳定的
 * `accountScope` 键之后，旧键必须清掉，否则磁盘上会一直留着。
 *
 * 文件不存在不抛（幂等）。
 */
export function removeInstallation(account) {
  if (!account) return false
  try {
    removeJson(installationFile(account))
    return true
  } catch {
    return false
  }
}

/**
 * 写安装记录。私钥留在这里；`chmod` 失败不抛（某些文件系统不支持），
 * 但不能因为权限设置失败就把记录写丢。
 *
 * ⚠ **写失败必须抛**（L-3）：`writeJson` 用返回值表达失败（磁盘满 / 权限 /
 *   序列化不了），而旧实现把它丢掉 —— 于是一条**什么都没写进去**的记录也一路
 *   「成功」，调用方（尤其是迁移）拿到的是一个磁盘上并不存在的身份。
 *   错误带上 status + code：宿主与卡片都要能分流，不能只回一句「出错了」。
 */
export function saveInstallation(account, record) {
  const file = installationFile(account)
  const value = { ...record, schemaVersion: RECORD_SCHEMA_VERSION }
  if (!writeJson(file, value)) {
    throw new ApiError(
      `安装记录写不进去：${file}（磁盘满 / 权限不足 / 路径不可写）。` +
        "本机设备身份没有保存成功，清理该目录后重试；本次没有把任何东西当成已保存。",
      { status: 502, code: CODES.internalError },
    )
  }
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows / 网络盘上没有 POSIX 权限位，忽略
  }
  return value
}

/** 删掉安装记录（换机、私钥泄露、用户主动重置时用） */
export function clearInstallation(account) {
  if (!account) return false
  return removeJson(installationFile(account))
}

/** 一条记录缺哪对持久化密钥（identity 不参与补齐：换 identity = 换 installationId） */
function missingKeyMaterial(record) {
  const missing = []
  if (!record?.devicePublicKey || !record?.devicePrivateKey) missing.push("device")
  if (!record?.inferencePublicKey || !record?.inferencePrivateKey) missing.push("inference")
  return missing
}

/**
 * 生成一条全新安装记录：自己造三把 ed25519 密钥，installationId 由 identity 公钥派生。
 *
 * 不写盘 —— 让调用方决定什么时候保存（注册失败时不该留下半条记录）。
 *
 * `accountScope` 留空：它的语义在服务端（Rust 侧的错误串叫 `desktop_account_scope_invalid`），
 * 本地猜一个只会在签名对不上时变成 `desktop_binding_invalid`；它只用于 device canonical
 * 第 2 段，**不参与** installationId 派生。
 */
export function createInstallation({ account, now = Date.now } = {}) {
  requiredString(String(account ?? ""), "createInstallation: account")
  const identity = generateEd25519KeyPair()
  const device = generateEd25519KeyPair()
  const inference = generateEd25519KeyPair()
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    account,
    // 官方算法：installationId = di_ + base64url(sha256(裸 32 字节公钥))
    installationId: installationIdFromPublicKey(identity.publicKeyB64Url),
    installationIdSource: "public_key",
    // identity：device canonical 的 publicKey 段 + x-desktop-* 头签名
    publicKey: identity.publicKeyB64Url,
    privateKey: identity.privateKeyB64Url,
    // device：body.device_public_key + body.device_signature
    devicePublicKey: device.publicKeyB64Url,
    devicePrivateKey: device.privateKeyB64Url,
    // inference：body.inference_public_key + 12 段推理证明；每次注册换新
    inferencePublicKey: inference.publicKeyB64Url,
    inferencePrivateKey: inference.privateKeyB64Url,
    publicKeyCreatedAt: now(),
    keyMaterialCreatedAt: now(),
    accountScope: "",
    inferenceToken: "",
    registeredAt: 0,
  }
}

/**
 * 补齐缺的密钥 + 纠正 installationId —— **纯函数，不落盘**。
 *
 * 拆出来是因为有两条路要它：`ensureKeyMaterial`（按当前键就地补）和
 * `adoptInstallationByScope`（迁移前先规范化，再写到新键 —— 只写一次盘）。
 *
 * 只补缺的：identity 与 installationId 一律不动 —— 这两样一变，服务端看到的就是
 * 另一台设备（旧的 409 记录也会跟着失效）。
 *
 * @returns {{ record: object, changed: boolean }} 缺了才改；`changed` 决定要不要落盘
 */
function normalizedKeyMaterial(record, { now = Date.now } = {}) {
  if (!record || typeof record !== "object") return { record, changed: false }
  const patch = {}
  const missing = missingKeyMaterial(record)
  if (missing.includes("device")) {
    const pair = generateEd25519KeyPair()
    patch.devicePublicKey = pair.publicKeyB64Url
    patch.devicePrivateKey = pair.privateKeyB64Url
  }
  if (missing.includes("inference")) {
    const pair = generateEd25519KeyPair()
    patch.inferencePublicKey = pair.publicKeyB64Url
    patch.inferencePrivateKey = pair.privateKeyB64Url
  }
  if (missing.length > 0) patch.keyMaterialMigratedAt = now()
  // 旧记录的 installationId 是 scope 哈希 / 随机占位 —— 官方 id 只由 identity 公钥决定，
  // 这里就地纠正（公钥不动，所以对服务端来说仍是同一台设备）。
  const expectedId = installationIdFromPublicKey(record.publicKey)
  if (record.installationId !== expectedId) {
    patch.installationId = expectedId
    patch.installationIdSource = "public_key"
  }
  if (Object.keys(patch).length === 0) return { record, changed: false }
  return { record: { ...record, ...patch }, changed: true }
}

/**
 * 就地补齐旧记录（0.2.3 只有 identity 那一对）。
 *
 * 只补缺的：identity 与 installationId 一律不动 —— 这两样一变，服务端看到的就是
 * 另一台设备（旧的 409 记录也会跟着失效）。补齐后立刻落盘，避免每次读都重算。
 */
export function ensureKeyMaterial(account, record, { now = Date.now } = {}) {
  const { record: next, changed } = normalizedKeyMaterial(record, { now })
  return changed ? saveInstallation(account, next) : record
}

/**
 * 换一把新的 inference 会话密钥并落盘（每次注册前调用）。
 *
 * 为什么每次换：重启实验证明 inference_public_key 每次变（sidecar 会话密钥），
 * 而 identity / device 不变。旧令牌由 `registeredAt` / `inferenceToken` 判断，
 * 这里只负责「下一次注册用哪把」。
 */
export function renewInferenceKey(account, record, { now = Date.now } = {}) {
  requiredString(String(account ?? ""), "renewInferenceKey: account")
  if (!record || typeof record !== "object") throw new TypeError("renewInferenceKey: record 必须是安装记录对象")
  const pair = generateEd25519KeyPair()
  return saveInstallation(account, {
    ...record,
    inferencePublicKey: pair.publicKeyB64Url,
    inferencePrivateKey: pair.privateKeyB64Url,
    inferenceKeyAt: now(),
  })
}

/**
 * 拿这个账号的安装记录；没有就新建并落盘（旧记录就地补密钥）。
 * 返回 `{ record, created }`，`created` 让调用方知道要不要走一次注册。
 */
export function ensureInstallation({ account, now = Date.now } = {}) {
  const existing = readInstallation(account)
  if (existing) return { record: ensureKeyMaterial(account, existing, { now }), created: false }
  const record = createInstallation({ account, now })
  saveInstallation(account, record)
  return { record, created: true }
}

/** 从记录还原身份私钥（每次从磁盘字节重建，不缓存密钥对象） */
export function identityPrivateKey(record) {
  if (!record?.privateKey) throw new TypeError("identityPrivateKey: 安装记录没有私钥")
  return importPrivateKey(record.privateKey)
}

/** 从记录还原身份公钥 */
export function identityPublicKey(record) {
  if (!record?.publicKey) throw new TypeError("identityPublicKey: 安装记录没有公钥")
  return importPublicKey(record.publicKey)
}

/** 从记录还原设备私钥（body.device_signature 用它签） */
export function devicePrivateKey(record) {
  if (!record?.devicePrivateKey) {
    throw new TypeError("devicePrivateKey: 安装记录没有 device 私钥（跑一次 ensureInstallation 补密钥）")
  }
  return importPrivateKey(record.devicePrivateKey)
}

/** 从记录还原设备公钥（body.device_public_key 用它） */
export function devicePublicKey(record) {
  if (!record?.devicePublicKey) {
    throw new TypeError("devicePublicKey: 安装记录没有 device 公钥（跑一次 ensureInstallation 补密钥）")
  }
  return importPublicKey(record.devicePublicKey)
}

/** 从记录还原推理会话私钥（12 段 inference canonical 用它签） */
export function inferencePrivateKey(record) {
  if (!record?.inferencePrivateKey) {
    throw new TypeError("inferencePrivateKey: 安装记录没有 inference 私钥（跑一次 ensureInstallation 补密钥）")
  }
  return importPrivateKey(record.inferencePrivateKey)
}

/** 从记录还原推理会话公钥 */
export function inferencePublicKey(record) {
  if (!record?.inferencePublicKey) {
    throw new TypeError("inferencePublicKey: 安装记录没有 inference 公钥（跑一次 ensureInstallation 补密钥）")
  }
  return importPublicKey(record.inferencePublicKey)
}

/** 这把私钥对应的公钥（base64url SPKI） */
export function publicKeyOfPrivate(privateKey) {
  return spkiB64Url(createPublicKey(privateKey))
}

/**
 * 记录里的公钥是不是这把私钥派生的。
 *
 * 为什么需要：缓存文件可能被替换/写坏。不先自检就去注册，服务端只会回
 * `desktop_binding_invalid`，而用户看到的是一条看不懂的失败。
 */
export function matchesPrivateKey(record) {
  try {
    return publicKeyOfPrivate(identityPrivateKey(record)) === record.publicKey
  } catch {
    return false
  }
}

/** 三把密钥是否互不相同（官方实测要求；不等就说明记录被写坏了） */
export function hasDistinctKeys(record) {
  const keys = [record?.publicKey, record?.devicePublicKey, record?.inferencePublicKey].filter(
    (value) => typeof value === "string" && value !== "",
  )
  return keys.length === 3 && new Set(keys).size === 3
}

/** 导出私钥的 base64url（只给本模块的测试用；不要打进日志） */
export function privateKeyEncoded(record) {
  return exportPrivateKey(identityPrivateKey(record))
}
