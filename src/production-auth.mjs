// src/production-auth.mjs —— 生产链：profile → 公钥派生 ID → 单次注册 → 无幂等键 activities → 落盘令牌
//
// 为什么需要它：之前 `loader` 只**读** `inferenceToken`，全仓库没有任何地方去注册设备、
// 换推理令牌、把令牌存下来 —— 那条路只有独立验证脚本会走，等于真正的插件本体是断的。
//
// 这条链的四个约束（缺一条就会变成「看起来能用」）：
//   ① **按账号单飞**：同一个账号并发进来只跑一次，不会注册两遍、不会换两次令牌；
//   ② **已就绪就不重跑**：记录里已有 accountScope + registeredAt + inferenceToken 就直接返回，
//      不产生任何请求（这就是「有效缓存不重复注册」）；
//   ③ **失败不伪装成功**：任一步抛错就原样抛，不留半条“已注册”记录；
//   ④ **令牌落盘**：`desktop_inference_token` 存进该账号的安装记录，重启后不必重新注册。
//
// installationId 由 **identity 公钥**派生（`di_` + base64url(sha256(裸 32 字节公钥))），
// 与 accountScope 无关；accountScope 只进 device canonical 第 2 段。
//
// ⚠ `activities/summary` **没有幂等键**：v1 canonical 第 7 段是空串，请求头也不发
//   `idempotency-key`。这一点由原始字节确认，不要“顺手加一个”。

import { ApiError } from "./api.mjs"
import { ensureInstallation, readInstallation, removeInstallation, renewInferenceKey, saveInstallation } from "./device-key.mjs"
import { fingerprint } from "./credential.mjs"
import { CODES } from "./http.mjs"
import { installationIdFromPublicKey } from "./installation-id.mjs"
import { fetchProfile, registerDevice, requestInferenceToken } from "./phanthy-api.mjs"
import { DeviceContractPending } from "./registration.mjs"

/**
 * 设备身份契约（2026-11-09 真机实测确认，200 通过）：
 *
 *   · `deviceKeyDistinct: true` —— 官方用**三把互不相同**的 ed25519 密钥。
 *     早先写成 `false`（device_public_key === public_key）是错的，服务端不接受。
 *   · `bindingSigner: "device"` —— body.device_signature 用 **device 私钥**签。
 *   · `headerSigner: "identity"` —— 请求头 x-desktop-signature 用 **identity 私钥**签。
 *
 * 三条都是实证，不是推测；依据与复现脚本见 `src/registration.mjs` 文件头与
 * `scripts/probe-e2e.mjs`。改这里的任何一项都等于换一套设备身份，先跑真机再说。
 */
export const IDENTITY_POLICY = Object.freeze({
  bindingSigner: "device",
  headerSigner: "identity",
  deviceKeyDistinct: true,
})

/** account → in-flight promise（挂住并发，不做缓存：缓存看记录本身） */
const inflight = new Map()

/**
 * 账号级设备绑定的熔断窗口：24 小时。
 *
 * 为什么需要：409 `desktop_installation_conflict` 是**终态**——这个 installation id
 * 在服务端已绑定官方桌面端的那把公钥，换任何格式、任何新公钥都还是同一条 409。
 * 如果每次启动/每次进 loader 都发一次注册，等于持续触发服务端的设备风控，
 * 还可能把这个账号的其它调用一起拖下水。所以失败一次后落盘熔断，期内**零请求**，
 * 只有用户显式重试（force）才会再发一次。
 */
export const REGISTRATION_COOLDOWN_MS = 24 * 60 * 60_000

/** installationId 脱敏：只留前 8 位，够核对同一性、看不出全值 */
export function maskInstallationId(installationId) {
  const text = String(installationId ?? "")
  return text ? `${text.slice(0, 8)}…` : "<none>"
}

/** 构造「账号级设备绑定」错误（词表内：device_binding_conflict / 409） */
export function deviceBindingConflict({ installationIdMasked = "<none>", detail = "" } = {}) {
  return Object.assign(
    new ApiError(
      "设备注册被账号级绑定拒绝：该 installation id 已绑定官方桌面端公钥，服务端不接受第二台设备" +
        `（installationId ${installationIdMasked}）。这不是格式问题，换公式/换公钥都会得到同一条 409；` +
        "推理面在此账号上不可用，数据面（模型目录 / 额度 / 签到只读）不受影响。" +
        (detail ? ` 上游原文：${detail}` : ""),
      { status: 409, code: CODES.deviceBindingConflict },
    ),
    { installationIdMasked, signIn: undefined },
  )
}

/** 注册闸门的环境变量名（现在是**显式 opt-out**：设成 `0` 才禁止注册） */
export const REGISTER_GATE_ENV = "PHANTHY_ALLOW_DEVICE_REGISTER"

/**
 * 是否允许进入注册链。
 *
 * ⚠ 语义在 0.2.15 反过来了：
 *   - 旧：必须设 `=1` 才允许（默认拒绝）→ magpie 是独立进程，用户设不到 ⇒ 永远拒绝
 *   - 新：默认**允许**，只有显式设成 `0` 才禁止（给严格只读数据面的场景留 opt-out）
 *
 * 409 账号级设备绑定的风险由 `isRegistrationBlocked` 的熔断器承担，不靠这个开关预防。
 */
export function isRegistrationAllowed(env = process.env) {
  return String(env?.[REGISTER_GATE_ENV] ?? "").trim() !== "0"
}

/** 熔断是否仍在生效 */
export function isRegistrationBlocked(record, now = Date.now) {
  const at = Number(record?.registrationUnavailableAt)
  return Number.isFinite(at) && at > 0 && now() - at < REGISTRATION_COOLDOWN_MS
}

/**
 * 推理令牌的 JWT 载荷（解析失败返回 null —— 畸形令牌按「过期」处理）。
 *
 * 官方 sidecar 的 `lw8()` 就是这么做的：先 `JSON.parse(base64url(payload))`，
 * 再校验 `proof_version === 2` 与 `inference_public_key === 当前会话公钥`。
 */
export function inferenceTokenPayload(token) {
  const text = String(token ?? "").trim()
  if (!text) return null
  const parts = text.split(".")
  if (parts.length < 2) return null
  try {
    const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 提前多久换票：令牌寿命实测只有约 3 分钟，提前 30 秒换，留出网络往返余量。
 *
 * ⚠ 不能用官方 `lw8()` 那个 300000ms 的**时钟偏移**当宽限：那是客户端本地自检
 *   用的（「我的钟比服务端快多少」），服务端自己并不给这段宽限 —— 真机上
 *   过期 168 秒的令牌仍然被服务端回 403 `request_not_authorized`。
 */
export const INFERENCE_TOKEN_REFRESH_LEAD_MS = 30_000

/**
 * 推理令牌是否**需要换票**（已过期，或即将过期）。
 *
 * 为什么必须单独判：`activities/summary` 签出来的 `desktop_inference_token` 是**短效**的
 * （实测 exp 距签发约 3 分钟）。早期 `isInstallationReady()` 只看「有没有令牌」，
 * 于是令牌一过期，`loader` 就拿着死票去签名 —— 服务端回
 * 403 `request_not_authorized`，而插件侧看不出任何异常（真机四问暴露）。
 *
 * 判据：载荷解析不出 / `proof_version !== 2` / `inference_public_key` 与记录里的
 * 推理公钥不一致 / `exp` 缺失 / `exp*1000 <= now + lead` —— 一律换票。
 */
export function isInferenceTokenExpired(
  record,
  { now = Date.now, leadMs = INFERENCE_TOKEN_REFRESH_LEAD_MS } = {},
) {
  const token = String(record?.inferenceToken ?? "").trim()
  if (!token) return true
  const payload = inferenceTokenPayload(token)
  if (!payload) return true
  if (payload.proof_version !== 2) return true
  const expected = String(record?.inferencePublicKey ?? "").trim()
  if (expected && String(payload.inference_public_key ?? "") !== expected) return true
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= 0) return true
  return Number(payload.exp) * 1000 <= now() + leadMs
}

/**
 * 记录是否已具备发起推理的全部条件。
 *
 * ⚠ id 必须与 **identity 公钥派生值**一致：0.2.3 的记录里 id 是 accountScope 哈希 /
 *   随机占位，那种记录即使有 registeredAt + 令牌也不能算就绪 —— 拿错 id 去签名，
 *   服务端只回一条看不懂的 409。
 * ⚠ 令牌还要**没过期**，否则 403 request_not_authorized。
 */
export function isInstallationReady(record, { now = Date.now } = {}) {
  if (!record?.installationId || !record?.accountScope || !record?.registeredAt || !record?.inferenceToken) {
    return false
  }
  if (isInferenceTokenExpired(record, { now })) return false
  try {
    return record.installationId === installationIdFromPublicKey(record.publicKey)
  } catch {
    return false
  }
}

/**
 * 确保这个账号的设备身份可用；返回最新的安装记录。
 *
 * @param {{
 *   account: string,
 *   auth: object,
 *   fetchImpl?: Function,
 *   now?: () => number,
 *   force?: boolean,        // 强制重跑注册（调试用；正常路径不要传）
 * }} options
 */
export async function ensureInstallationReady({ account, auth, fetchImpl, now = Date.now, force = false } = {}) {
  if (typeof account !== "string" || account.trim() === "") {
    throw new ApiError("缺少账号指纹，无法建立设备身份", { status: 400, code: "invalid_request" })
  }
  const key = String(account)
  const running = inflight.get(key)
  if (running) return running

  const task = (async () => {
    let { record } = ensureInstallation({ account: key, now })
    if (!force && isInstallationReady(record)) return record

    // ⚠ 0.2.15 起**不再要求 `PHANTHY_ALLOW_DEVICE_REGISTER=1`**。
    //
    //   那个闸门和本机导入的同名设计犯了同一个错：**magpie 是独立进程**，
    //   用户在 shell 里设的环境变量它看不到。于是「登录成功 + 额度正常 + 模型列表
    //   13 条」的账号，一发推理就回 502「推理面未接通」，而用户根本没法让它接通
    //   （2026-11-09 真机：登录后第一次请求就撞上）。
    //
    //   真正的风险只有一条：注册可能回 **409 账号级设备绑定**。但那个风险已经有
    //   专门的熔断器管着（`isRegistrationBlocked`，409 之后在退避期内一条都不发），
    //   所以不需要再用一个用户设不到的开关去「预防」它。
    //
    //   保留 `REGISTER_GATE_ENV` 作为**显式 opt-out**：设成 `0` 表示「绝对不要注册」，
    //   给需要严格只读数据面的场景用。默认行为 = 允许注册。
    const needsRegistration = force || !record.registeredAt
    if (needsRegistration && !force && !isRegistrationAllowed()) {
      throw new ApiError(
        "推理面未接通：设备注册被 `PHANTHY_ALLOW_DEVICE_REGISTER=0` 显式关闭了。" +
          "去掉这个环境变量（或设成 1）后重新发一次请求。" +
          "数据面（模型目录 / 额度 / 签到只读）不受影响。",
        { status: 501, code: "not_implemented" },
      )
    }

    // 熔断：409 是终态，期内一条注册都不发（这是「加载时零注册」的保证）
    if (needsRegistration && !force && isRegistrationBlocked(record, now)) {
      throw deviceBindingConflict({
        installationIdMasked: maskInstallationId(record.installationId),
        detail: String(record.registrationUnavailableMessage ?? ""),
      })
    }

    // ① accountScope 只能来自账号档案。
    //    ⚠ 它**只**进 device canonical 第 2 段，**不参与** installationId 派生 ——
    //    id 由 identity 公钥派生（`di_` + base64url(sha256(裸公钥))），见 installation-id.mjs。
    //    早期实现拿 scope 哈希出 id，是 409 desktop_installation_conflict 的根因。
    if (!record.accountScope) {
      const profile = await fetchProfile(auth, { fetchImpl })
      const scope = accountScopeFromProfileLazy(profile)
      record = saveInstallation(key, { ...record, accountScope: scope })
    }

    // ①b 令牌刷新会换 uid（`uidOf` 在 api 型凭据上回退到「凭据指纹」），
    //     而 magpie 对 `type: "api"` 只存 `{type, key}`、**不存 uid** ——
    //     于是每 30 分钟刷新一次就换一个 key，每次都会新建一条设备安装记录、
    //     重新注册一次设备（真机上攒出 4 条孤儿记录，界面里额度窗口重复显示）。
    //
    //     稳定锚点只有 `accountScope`：拿到它之后，如果这个账号已经有一条**已注册**的
    //     记录挂在别的 key 下，就把它迁过来复用 —— identity 公钥与 installationId 都不动，
    //     服务端看到的是同一台设备。
    const scopeKey = fingerprint(record.accountScope)
    if (scopeKey && scopeKey !== key && !record.registeredAt) {
      const existing = readInstallation(scopeKey)
      if (existing?.registeredAt && existing?.publicKey) {
        record = saveInstallation(scopeKey, { ...existing })
        removeInstallation(key)
        return record
      }
      // 没有可复用的就正常往下走（这个 scope 是第一次见）
    }

    // ② 单次完整注册（同一个 installationId 必然一致，不做 A/B 双探针：会撞幂等键）
    if (force || !record.registeredAt) {
      // inference 是 sidecar 会话密钥：**每次注册现生成**（重启实验证明它每次变，
      // 而 identity / device 跨重启不变）。body.inference_public_key 与后面的
      // 12 段推理证明都用这一把，所以必须在注册前落盘。
      record = renewInferenceKey(key, record, { now })
      try {
        const out = await registerDevice({
          auth,
          record,
          policy: IDENTITY_POLICY,
          sessionKeyPublicKey: record.inferencePublicKey,
          accountScope: record.accountScope,
          fetchImpl,
          now,
        })
        record = saveInstallation(key, { ...record, registeredAt: now(), registrationStatus: out?.response?.status ?? 200 })
      } catch (error) {
        const code = String(error?.code ?? error?.body?.error?.code ?? "")
        const binding = error?.status === 409 || /desktop_installation_conflict/.test(code)
        if (binding) {
          // 终态：落盘熔断，别再让上层重试
          record = saveInstallation(key, {
            ...record,
            registrationUnavailableAt: now(),
            registrationUnavailableStatus: 409,
            registrationUnavailableCode: "device_binding_conflict",
            registrationUnavailableMessage: String(error?.message ?? "").slice(0, 300),
            installationIdMasked: maskInstallationId(record.installationId),
          })
          throw deviceBindingConflict({
            installationIdMasked: maskInstallationId(record.installationId),
            detail: String(error?.message ?? ""),
          })
        }
        throw error
      }
    }

    // ③ activities/summary：无幂等键，拿到 desktop_inference_token 并落盘
    // ③ activities/summary：无幂等键，拿到 desktop_inference_token 并落盘
    //
    // ⚠ 判据是「**过期了也要换**」，不是「没有才换」。这个令牌是短效的（实测 exp 距签发
    //   约 3 分钟），只判「有没有」会让插件拿死票去签名 → 403 request_not_authorized，
    //   而插件侧看起来一切正常（真机四问暴露）。
    if (!record.inferenceToken || force || isInferenceTokenExpired(record, { now })) {
      const { token, serverTime } = await requestInferenceToken({ auth, account: key, fetchImpl, now })
      record = saveInstallation(key, {
        ...record,
        inferenceToken: token,
        inferenceTokenAt: now(),
        inferenceTokenServerTime: serverTime ?? "",
      })
    }

    return record
  })()

  inflight.set(key, task)
  try {
    return await task
  } finally {
    inflight.delete(key)
  }
}

/** 单独包一层，让「缺 account.uuid」的报错带上契约说明（错误码仍走词表） */
function accountScopeFromProfileLazy(profile) {
  const scope = profile?.account?.uuid
  if (typeof scope !== "string" || scope.trim() === "") {
    throw new ApiError(
      "账号档案里没有 account.uuid：installationId 只能由它派生，不能用 JWT sub / 邮箱代替",
      { status: 502, code: "internal_error", body: profile },
    )
  }
  return scope
}

/** 清掉某账号的 in-flight 表（测试用） */
export function _resetInflight() {
  inflight.clear()
}

export { DeviceContractPending }
