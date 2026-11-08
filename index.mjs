// magpie 插件：PhanthyWork 云端 Phanthy（独立实现，不依赖桌面端）
//
// 这个插件不安装、不读取、不启动 PhanthyWork 桌面端或 claude-sidecar：
// 它自己走官方 OAuth（授权码 + PKCE S256）、自己生成 ed25519 设备身份、
// 自己签 v1 / device / inference 三条 canonical。
//
// ═══════════════════════════════════════════════════════════════════════
// 九项清单
// ═══════════════════════════════════════════════════════════════════════
//
//  钩子（magpie 会调）
//   ① config(cfg)                     声明 provider + 静态模型表
//   ② auth.methods[].authorize()      登录（OAuth 2.1 + PKCE，loopback 回调）
//   ③ auth.refresh(auth, provider)    续期（refresh lock 串行）
//   ④ auth.loader(getAuth, provider)  请求接管（baseURL + 每请求签名）
//   ⑤ auth.usage(getAuth, provider)   额度 → 卡片进度条
//   ⑥ auth.checkin(getAuth, provider) 签到（本服务没有插件侧签到）
//   ⑦ provider.models(provider,{auth}) 每账号模型目录
//   ⑧ "chat.headers"(input, output)   每请求加会话头
//
//  数据字段（不是钩子但决定 UI）
//   ⑨ accountId / uid                 卡片显示名 + 同名区分
//      auth.icon / magpie.icon         卡片图标
//      auth.maxConcurrency             并发数
//
// ═══════════════════════════════════════════════════════════════════════
// 三条铁律
// ═══════════════════════════════════════════════════════════════════════
//
// 1. config.models 必须有内容 —— 未登录也要有，否则显示 "0 models"
// 2. authorize() 立刻返回 —— 真正等登录的是 callback()
// 3. refresh 返回的是合并 —— client.auth.set 是整体替换，两者不同
//
// ═══════════════════════════════════════════════════════════════════════
// 本插件当前的边界（不要悄悄改掉）
// ═══════════════════════════════════════════════════════════════════════
//
// 数据面（目录 / 额度 / 钱包）已完整实现：只用一个 OAuth Bearer，端点与形状见
// src/phanthy-api.mjs。
//
// 推理面（/v1/messages）的**请求签名**已经实现（src/proof.mjs + 下方 loader）。
// 设备注册的三项契约 2026-11-09 已由真机实测确认（三把独立密钥 / device 私钥签
// device_signature / identity 私钥签 v1 头，见 src/registration.mjs 文件头），
// 但注册仍默认关闭 —— 它会在服务端留下设备绑定，属于**写操作**：
//   · 设备注册默认关闭（PHANTHY_ALLOW_DEVICE_REGISTER≠1）→ 501 not_implemented
//   · 服务端真的回 409 desktop_installation_conflict  → 409 device_binding_conflict（终态）
// 要在本机跑通推理链，显式开 PHANTHY_ALLOW_DEVICE_REGISTER=1。

import { ApiError, TIMEOUT, asSignInExpired, isAuthFailure } from "./src/api.mjs"
import { catalogEntries } from "./src/catalog.mjs"
import { createCatalogCache } from "./src/catalog-cache.mjs"
import {
  BASE,
  ICON,
  MODELS,
  PROVIDER,
  PROVIDER_NAME,
  REFRESH_LEAD_MS,
  SDK,
  staticModels,
} from "./src/context.mjs"
import { looksLikeIdentifier } from "./src/account-name.mjs"
import { fingerprint, uidOf } from "./src/credential.mjs"
import { findInstallationByScope, readInstallation } from "./src/device-key.mjs"
import { ensureInstallationReady, isInstallationReady } from "./src/production-auth.mjs"
import { detectLocalLogin, readImportedAccess, summarizeDetection } from "./src/local-import.mjs"
import { OFFICIAL_UA, isLoginBroken } from "./src/http.mjs"
import {
  CALLBACK_PATH,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  isCredentialRejected,
  refreshAccessToken,
} from "./src/oauth.mjs"
import { generatePkce, randomState, startLoopback } from "./src/oauth-pkce.mjs"
import { fetchCatalog, fetchProfile, request as phanthyRequest } from "./src/phanthy-api.mjs"
import { createDailyActivity, dailyLoginReward, dailyLoginStreak } from "./src/activity.mjs"
import {
  importPrivateKey,
  inferenceCanonical,
  randomNonce,
  randomRequestId,
  signCanonical,
  timestampNow,
} from "./src/proof.mjs"
import { QuotaShapeError } from "./src/quota.mjs"
import { createRefreshLock } from "./src/refresh-lock.mjs"
import { buildUsageReport } from "./src/usage-windows.mjs"
import { createUsageCache } from "./src/usage-cache.mjs"

const ANTHROPIC_VERSION = "2023-06-01"

/**
 * 宿主透传下来的、必须在重建 headers 时丢掉的项。
 *
 * `content-length` / `transfer-encoding` / `connection` 是 hop-by-hop 头（PROTOCOL-INFERENCE.md
 * 的删除名单）；`authorization` / `x-api-key` 换成插件自己的 Bearer；`user-agent` 换官方 UA；
 * 四个证明头由下面重新生成（官方桥也是先删后签）。
 */
const HOST_HEADERS_TO_DROP = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "authorization",
  "x-api-key",
  "user-agent",
  "x-phanthy-desktop-session",
  "x-phanthy-proof-signature",
  "x-phanthy-proof-nonce",
  "x-phanthy-proof-timestamp",
]

/** 两种登录方式共用的 Bearer 取值：OAuth 是 access，本机导入是 key */
function bearerOf(auth) {
  return String(auth?.access || auth?.key || "").trim()
}

/**
 * 插件工厂。
 *
 * `_options.fetch` 只给测试注入用：真实运行时 magpie 不传它，回落到全局 fetch。
 * 注入的意义是「离线测试不碰网络」，不是运行时开关。
 */
/**
 * 解析请求器。真实踩过的坑：测试里把注入写成 `{ fetchImpl }`（插件读的是
 * `_options.fetch`），于是回落到全局 fetch，用一个假 token 真打了一次云端。
 *
 * 所以这里做两件事：
 *   ① 注入名写错（给了 fetchImpl 却没有 fetch）直接抛错，不静默回落；
 *   ② 测试环境（NODE_TEST_CONTEXT）下回落只允许回环地址，外部出站一律拒绝。
 */
function resolveFetch(options = {}) {
  if (typeof options.fetch === "function") return options.fetch
  if (typeof options.fetchImpl === "function") {
    throw new TypeError("请求器要用 { fetch } 注入，不是 { fetchImpl }")
  }
  return (input, init) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input ?? "")
    const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)
    if (process.env.NODE_TEST_CONTEXT && !loopback) {
      throw new TypeError(`测试环境禁止外部出站：${url.slice(0, 120)}（请用 { fetch } 注入假请求器）`)
    }
    return globalThis.fetch(input, init)
  }
}

export const PhanthyCodeAuthPlugin = async (_ctx = {}, _options = {}) => {
  const fetchImpl = resolveFetch(_options)

  // 同一 refresh_token 的并发续期合并成一次，成功后 60 秒内回放结果。
  // 键必须是凭据身份（refresh_token），不能用 provider id —— 同渠道多账号会串结果。
  const refreshLock = createRefreshLock({ replayMs: 60_000 })

  // 额度卡片会被频繁刷新：成功 60 秒、失败 5 秒，同 key 并发合并。
  const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })

  // 签到按账号 single-flight；不回放成功结果（每天只有一次机会，回放没有意义）。
  const checkinLock = createRefreshLock({ replayMs: 0 })

  // 模型目录：按账号缓存 10 分钟、失败 30 秒、同 key 单飞；上游挂了退回上次快照。
  const catalogCache = createCatalogCache({ ttlMs: 10 * 60_000, failTtlMs: 30_000 })

  return {
    // ═══ ① 声明 provider ══════════════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      // ⚠ 用 ??= ，不要覆盖用户在 plugins.json 里配的
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: BASE,
        models: staticModels(), // ⚠ 未登录时也必须有内容
      }
    },

    auth: {
      provider: PROVIDER,

      // 数据字段：图标要写两份（这里 + package.json 的 magpie.icon）
      icon: ICON,
      maxConcurrency: 4,
      refreshLead: REFRESH_LEAD_MS,

      // ═══ ② 登录 ═══════════════════════════════════════════════════
      methods: [
        {
          type: "oauth",
          label: `Sign in with ${PROVIDER_NAME}`,

          /**
           * ⚠ 必须立刻返回：这里只做「开一个 loopback 监听 + 拼授权地址」，
           *   等用户完成登录的是 callback()。在 authorize 里 await 用户会死锁。
           */
          async authorize() {
            const state = randomState()
            const pkce = generatePkce()
            const listener = await startLoopback({ state, path: CALLBACK_PATH })
            const url = buildAuthorizeUrl({
              base: BASE,
              redirectUri: listener.redirectUri,
              state,
              codeChallenge: pkce.challenge,
            })

            return {
              url,
              instructions: "在浏览器里完成 Phanthy 登录，这个窗口会自动继续。",
              method: "auto",
              opened: false,

              async callback(code) {
                try {
                  const redirected = typeof code === "string" && code ? { code, state } : await listener.wait()
                  if (redirected?.state && redirected.state !== state) {
                    return { type: "failed", error: "state 校验失败（可能有另一个页面撞到了回调端口），请重试" }
                  }
                  const token = await exchangeAuthorizationCode({
                    code: redirected?.code,
                    state,
                    codeVerifier: pkce.verifier,
                    redirectUri: listener.redirectUri,
                    base: BASE,
                    fetchImpl,
                  })

                  // ⚠ 换票响应里**没有** profile：账号名必须自己补一次。
                  //   不补的话 `accountId` 是空串，卡片显示「Signed in」（0.2.14 真机）。
                  //   锚点与「从本机导入」同一套：`display_name`（服务端已打码）进
                  //   `accountId` + `metadata.email`，`account.uuid` 的指纹进 `uid`
                  //   （稳定，不随 token 刷新变）。
                  let accountId = ""
                  let uid = fingerprint(token.access)
                  let accountScope = ""
                  try {
                    const profile = await fetchProfile({ access: token.access }, { fetchImpl })
                    accountScope = String(profile?.account?.uuid ?? "").trim()
                    if (accountScope) uid = fingerprint(accountScope)
                    const displayName = String(
                      profile?.account?.display_name ?? profile?.account?.email ?? "",
                    ).trim()
                    if (displayName && !looksLikeIdentifier(displayName)) accountId = displayName
                  } catch {
                    // 拿不到 profile 也不阻塞登录：退回凭据指纹、卡片显示供应商名
                  }

                  return {
                    type: "success",
                    refresh: token.refresh || "",
                    access: token.access,
                    expires: token.expires,
                    accountId,
                    // api 型登录态只有 `metadata.email` 能落盘，见下方注释；
                    // oauth 型会同时留 accountId，但写两份不会有副作用。
                    ...(accountId ? { email: accountId, metadata: { email: accountId } } : {}),
                    uid,
                    ...(accountScope ? { accountScope } : {}),
                  }
                } catch (error) {
                  return { type: "failed", error: String(error?.message ?? error) }
                } finally {
                  try {
                    listener.close()
                  } catch {}
                }
              },
            }
          },
        },

        {
          type: "api",
          /**
           * ⚠ `keyless: true` 不能省。这个登录方式**不收任何输入**（读的是本机文件），
           *   而 magpie 对 `type: "api"` 的默认渲染是「粘贴 API key」的输入框。
           *   不写它，用户点开看到的就是一个要求填写的空框（占位文字写「无需填写」更糟：
           *   界面在要输入，文案说别输入），点了「登录」才会因为没开开关而失败。
           *
           *   宿主行为（`~/.cache/magpie/plugin-host/host-*.js:2373` 透传 keyless，
           *   magpie.exe 分派处 `ms[method].keyless === true` → `pluginKey(sub, "")`）：
           *   keyless 的 api 方式**跳过输入直接调 authorize("")**，就是我们要的「一个按钮」。
           */
          keyless: true,
          label: "从本机导入 PhanthyWork 登录",

          /**
           * 只导入**云端 OAuth access token**，其它一律不碰：
           * refresh_token 会让桌面端掉线、推理令牌与设备私钥属于复制设备会话。
           * 设备身份仍由本插件自己生成（见 src/device-key.mjs）。
           *
           * ⚠ 0.2.14 起**不再要求 `PHANTHY_ALLOW_LOCAL_IMPORT=1`**。
           *
           *   原来的「环境变量闸门」是个只会误伤的设计：magpie 是**独立进程**，
           *   用户在 shell 里 set 环境变量对它一点用都没有 —— 真机上点「从本机导入」
           *   永远只会看到「本机导入未启用」，用户以为插件坏了（2026-11-09 实测）。
           *   而所谓「风险」其实不存在：这里**只读一个未过期的云端 access token**，
           *   不碰 refresh_token、不碰推理令牌、不碰设备私钥 —— 见 `readImportedAccess`。
           *   真正需要闸门的是「读到就上传」这一类比，而本插件只是把本机已有的登录
           *   复用到 magpie，与用户在 magpie 里手粘贴同一个 token 等价。
           */
          async authorize() {
            const detection = detectLocalLogin()
            if (!detection.importable) {
              const summary = summarizeDetection(detection)
              return { type: "failed", error: `本机没有可导入的云端登录：${summary.lines.join("；")}` }
            }
            try {
              const imported = readImportedAccess()

              // ⚠ `uid` 必须是**稳定身份**，不能省。
              //
              //   `uidOf(auth)` 的取法是 `auth.uid || fingerprint(凭据原值)`。
              //   access token 每约 30 分钟刷新一次、值必然变 ⇒ 不写 `uid` 就等于
              //   「每刷新一次就换一个账号身份」⇒ 每次都在 `~/.cache/magpie` 新建一条
              //   设备安装记录、每 30 分钟重新注册一次设备（真机上攒出 4 条孤儿记录）。
              //
              //   稳定锚点只有一个：账号档案里的 `account.uuid`（`accountScope`）。
              //   它是**名字**的替代品（`accountId` 仍留空，让宿主回退成供应商名），
              //   只进 `uid`。
              //
              //   这里多打一次 `GET /api/oauth/profile` 是可接受的：登录是一次性动作，
              //   不是每个请求都走（HOOKS 铁律 2 针对的是「不要在 authorize 里等用户」）。
              let accountScope = ""
              let accountId = ""
              let uid = ""
              try {
                const profile = await fetchProfile({ access: imported.access }, { fetchImpl })
                accountScope = String(profile?.account?.uuid ?? "").trim()
                if (accountScope) uid = fingerprint(accountScope)
                // ⚠ `accountId` 是**名字**（HOOKS 八）：官方客户端卡片上显示的就是
                //   `+86 178****4697` —— 服务端的 `display_name` / `email` 已经打好码了，
                //   原样用即可。**不要**再过一遍 `maskPhone()`：它会剥掉 `+86 ` 前缀，
                //   显示成 `178****4697`，与官方客户端对不上。
                //   但内部 ID（URN / uuid / 裸 hash）不能当名字（坑 27）。
                const displayName = String(profile?.account?.display_name ?? profile?.account?.email ?? "").trim()
                if (displayName && !looksLikeIdentifier(displayName)) accountId = displayName
              } catch {
                // 拿不到 profile 也不阻塞登录：退回凭据指纹（会随刷新变，但不至于登不上）
              }

              return {
                type: "success",
                key: imported.access,
                accountId,
                // ⚠ 三处都写同一个值，但**真正生效的是 `metadata.email`**。
                //
                //   宿主的取法（`host-*.js` 的 `whoOf`）：
                //     a?.accountId ?? a?.metadata?.email ?? a?.email ?? ""
                //
                //   而 magpie 的 `/api/plugin-signin` 对 **api 型**登录态
                //   只持久化 `{ type, key, metadata }` —— `accountId` / `uid` /
                //   `expires` 全被丢掉（2026-11-09 实测：干净重新登录后
                //   `plugin-auth.json` 里只剩这三项，卡片回退成「API key …xxxx」）。
                //
                //   所以 `metadata.email` 才是 api 型唯一能落盘的显示名，必须写；
                //   另外两个照写不误（oauth 型 / 未来 magpie 版本可能会留）。
                ...(accountId ? { email: accountId, metadata: { email: accountId } } : {}),
                ...(uid ? { uid } : {}),
                ...(accountScope ? { accountScope } : {}),
                ...(imported.expires > 0 ? { expires: imported.expires } : {}),
              }
            } catch (error) {
              return { type: "failed", error: String(error?.message ?? error) }
            }
          },
        },
      ],

      // ═══ ③ 续期 ═══════════════════════════════════════════════════
      async refresh(auth) {
        if (!auth?.refresh) return undefined // 没有 refresh_token，不续期
        try {
          const t = await refreshLock.run(`${PROVIDER}\n${auth.refresh}`, () =>
            refreshAccessToken({ refreshToken: auth.refresh, base: BASE, fetchImpl }),
          )

          // ⚠ `refresh` 的返回值会**合并**进旧记录（HOOKS 铁律 3），所以顺带把账号名补上：
          //   浏览器 OAuth 第一次登录时若没取到 profile（网络抖动 / 老版本登录），
          //   卡片会一直显示「Signed in」。续期是自愈的时机 —— 一次刷新就修好，
          //   不用让用户重新登录。
          let accountId = ""
          let accountScope = ""
          let uid = ""
          if (!auth.accountId) {
            try {
              const profile = await fetchProfile({ access: t.access }, { fetchImpl })
              accountScope = String(profile?.account?.uuid ?? "").trim()
              if (accountScope) uid = fingerprint(accountScope)
              const displayName = String(profile?.account?.display_name ?? profile?.account?.email ?? "").trim()
              if (displayName && !looksLikeIdentifier(displayName)) accountId = displayName
            } catch {
              // profile 拿不到就只续期，不阻塞
            }
          }

          return {
            access: t.access,
            // 服务端可能不轮换 refresh_token，没给就沿用旧的（否则用户被要求重登）
            refresh: t.refresh || auth.refresh,
            expires: t.expires,
            ...(accountId ? { accountId, email: accountId, metadata: { email: accountId } } : {}),
            ...(uid ? { uid } : {}),
            ...(accountScope ? { accountScope } : {}),
          }
        } catch (error) {
          if (isCredentialRejected(error)) throw asSignInExpired("登录已失效，请重新登录")
          throw error
        }
      },

      // ═══ ④ 请求接管 ═══════════════════════════════════════════════
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth || !bearerOf(auth)) return {}

        return {
          // @ai-sdk/anthropic 会在 baseURL 后面拼 /messages，所以这里必须带到 /v1
          baseURL: `${BASE}/v1`,
          apiKey: bearerOf(auth),
          headers: {
            "user-agent": OFFICIAL_UA,
            "anthropic-version": ANTHROPIC_VERSION,
          },

          async fetch(input, init) {
            const fresh = await getAuth()
            const bearer = bearerOf(fresh)
            if (!bearer) throw asSignInExpired("登录已失效，请重新登录")

            const req = input instanceof Request ? input : null
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.toString() : (req?.url ?? "")
            const method = String(init?.method ?? req?.method ?? "POST").toUpperCase()
            const incoming = new Headers(init?.headers ?? req?.headers ?? {})
            const body =
              init?.body !== undefined && init?.body !== null
                ? typeof init.body === "string"
                  ? init.body
                  : null
                : req
                  ? await req.text()
                  : ""

            if (body === null) {
              // 流式 body 不能在这里读（读了就破坏了流）——按缺口处理，不猜。
              throw new ApiError("请求体不是字符串，无法在签名前确定字节；请把 body 序列化后再发", {
                status: 400,
                code: "invalid_request",
              })
            }

            // ⚠ UA 必须在这里显式写死（AGENTS 坑 38）：
            //   · 不写 → 宿主把 `magpie/<version>` 原样透传，上游网关按 <product>/<version>
            //     判成第三方客户端，回 403 TM.00000001（文案「网络繁忙」）
            //   · 写但被下面的复制循环覆盖 → 同上（宿主在更外层也会塞一份 user-agent）
            //   `scripts/check-ua.mjs` 只看字面量，看不见这两条路径，
            //   行为断言在 tests/loader-ua.test.mjs。
            const headers = {
              authorization: `Bearer ${bearer}`,
              "content-type": "application/json",
              "anthropic-version": ANTHROPIC_VERSION,
              "user-agent": OFFICIAL_UA,
            }
            // 键统一小写：HTTP 头名大小写不敏感，但下面要按名字删/改写，
            // 保留原大小写会出现「删了 `X-Phanthy-Expert-Id`、又发出去一份 `x-phanthy-expert-id`」。
            for (const [key, value] of incoming) {
              const lower = key.toLowerCase()
              if (HOST_HEADERS_TO_DROP.includes(lower)) continue
              headers[lower] = value
            }

            // 官方桥的 ①：`x-phanthy-session` 摊成会话三件套（PROTOCOL-INFERENCE.md §二）。
            // 会话元数据表（expert / skill）在 sidecar 内存里，插件拿不到 —— 拿不到就写空串，
            // canonical 后三段本来就允许空（少写一段会变成另一个串）。
            const phanthySession = incoming.get("x-phanthy-session")
            if (phanthySession) {
              headers["x-claude-code-session-id"] = phanthySession
              delete headers["x-phanthy-expert-id"]
              delete headers["x-phanthy-skill-names"]
            }

            // 推理证明：先走生产链确保「注册 + 推理令牌」就绪（已就绪则零请求）
            const account = uidOf(fresh)
            if (!account) throw asSignInExpired("凭据缺少账号指纹，请重新登录")

            let installation = readInstallation(account)
            if (!isInstallationReady(installation)) {
              installation = await ensureInstallationReady({ account, auth: fresh, fetchImpl })
            }
            const inferenceToken = String(installation?.inferenceToken ?? "").trim()
            if (!inferenceToken) {
              throw new ApiError("设备注册完成但没拿到 desktop_inference_token", {
                status: 502,
                code: "internal_error",
              })
            }

            const pathname = new URL(url).pathname
            const requestId = incoming.get("x-request-id") || randomRequestId()
            // ⚠ 这三段必须读**最终要发出去的头**（`headers`），不能读 `incoming`：
            //   `x-phanthy-session` 在上面被摊成了 `x-claude-code-session-id`，
            //   而 `x-phanthy-expert-id` / `-skill-names` 可能已被删掉。
            //   读 `incoming` 会拿到展开前的旧值 ⇒ canonical 第 10–12 段与实发头不一致
            //   ⇒ 服务端算出的串不同 ⇒ 403 request_not_authorized（真机四问暴露）。
            const sessionId = String(headers["x-claude-code-session-id"] ?? "")
            const expertId = String(headers["x-phanthy-expert-id"] ?? "")
            const skillNames = String(headers["x-phanthy-skill-names"] ?? "")

            // ⚠ 顺序：先定 body 字节 → 再拼 canonical → 再签 → 最后原样发出
            const timestamp = timestampNow()
            const nonce = randomNonce()
            const canonical = inferenceCanonical({
              method,
              pathname,
              timestamp,
              nonce,
              body,
              authorization: headers.authorization,
              inferenceToken,
              requestId,
              sessionId,
              expertId,
              skillNames,
            })
            const signature = signCanonical(inferenceKeyOf(installation), canonical)

            headers["x-request-id"] = requestId
            // 官方客户端把 desktop_inference_token 放进这个头（2026-11-09 真机实测；
            // 它**不在** 12 段 canonical 里，但缺了服务端不认这次推理）。
            headers["x-phanthy-desktop-session"] = inferenceToken
            headers["x-phanthy-proof-timestamp"] = timestamp
            headers["x-phanthy-proof-nonce"] = nonce
            headers["x-phanthy-proof-signature"] = signature

            // 超时分类（ERROR-CODES R8）：abort/超时必须落 504，不能把裸 AbortError 扔进聊天通道。
            // 宿主自己的 signal（切会话 / 用户停止）优先，且不算超时。
            const callerSignal = init?.signal ?? req?.signal ?? undefined

            const send = async () => {
              const timeoutSignal = callerSignal ? undefined : AbortSignal.timeout(TIMEOUT.stream)
              return await callUpstream(
                () =>
                  fetchImpl(url, {
                    method,
                    headers,
                    body,
                    signal: callerSignal ?? timeoutSignal,
                  }),
                { callerSignal, timeoutSignal },
              )
            }

            let res = await send()

            // 官方桥的 403 兜底（PROTOCOL-INFERENCE.md §七，对应 sidecar 的 `bd3` 尾部循环）：
            //
            //   官方：`for (let i = 0; i < Ad3 && Z.status === 403; i++) { if (!await Ld3(Z)) break;
            //          await R$7(...); await Z.body?.cancel(); Z = await J() }`
            //   · `Ld3` 只读前 64 KiB、2 秒超时，判断 `error.code === "request_not_authorized"`
            //   · `Ad3 = 2`（最多重试 2 次）
            //   · 官方 `R$7` 本身只换 OAuth；推理令牌靠「桥通知客户端重新走 activities/summary」，
            //     由 `lK9` 在响应里捕获（`Z44` → `Ip3`）。插件既是客户端又是桥，所以这里
            //     **直接重新签发推理令牌**，等价于官方那条「通知→重签」回路。
            //
            // 没有这条兜底，令牌一过期（实测寿命约 3 分钟）用户就会看到
            // 「当前请求不可用」，而插件侧完全看不出该换票（真机四问暴露）。
            const MAX_INFERENCE_RETRIES = 2
            for (let attempt = 0; attempt < MAX_INFERENCE_RETRIES; attempt += 1) {
              if (res.status !== 403 || callerSignal?.aborted) break
              const peek = await res
                .clone()
                .arrayBuffer()
                .then((buf) => Buffer.from(buf.subarray(0, 65_536)).toString("utf8"))
                .catch(() => "")
              if (!/request_not_authorized/.test(peek)) break

              const renewed = await ensureInstallationReady({
                account,
                auth: fresh,
                fetchImpl,
              })
              const nextToken = String(renewed?.inferenceToken ?? "").trim()
              if (!nextToken) break

              // 换票后必须**按新的票重签**：canonical 第 8 段是 b64url(sha256(token))。
              const retryTimestamp = timestampNow()
              const retryNonce = randomNonce()
              const retryCanonical = inferenceCanonical({
                method,
                pathname,
                timestamp: retryTimestamp,
                nonce: retryNonce,
                body,
                authorization: headers.authorization,
                inferenceToken: nextToken,
                requestId,
                sessionId,
                expertId,
                skillNames,
              })
              headers["x-phanthy-desktop-session"] = nextToken
              headers["x-phanthy-proof-timestamp"] = retryTimestamp
              headers["x-phanthy-proof-nonce"] = retryNonce
              headers["x-phanthy-proof-signature"] = signCanonical(inferenceKeyOf(renewed), retryCanonical)

              await res.body?.cancel().catch(() => {})
              res = await send()
            }

            // 402（额度）/ 403（套餐）如实交给宿主，不自作主张改成 401。
            // 但 401 / 403 里「不是登录问题」的那部分要带 `X-Magpie-Sign-In: kept`
            // （ERROR-CODES R5）：否则上游对单个模型回 401，宿主会把整个账号停用。
            return await withSignInHint(res)
          },
        }
      },

      // ═══ ⑤ 额度 ═══════════════════════════════════════════════════
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth) return { error: "未登录", windows: [] }

        const usageKey = uidOf(auth)
        if (!usageKey) return { error: "未登录", windows: [] }

        let u
        try {
          u = await usageCache.readSWR(
            String(usageKey),
            () => buildUsageReport({ auth, fetchImpl }),
            { timeoutMs: 10_000 },
          )
        } catch (error) {
          // 额度窗口**写错了**是编码错误，必须让作者看见堆栈（src/quota.mjs 文件头的要求）。
          // 吞成 usage.error 就又会变成「GUI 坏了但日志里什么都没有」（审计 F7）。
          if (error instanceof QuotaShapeError) throw error
          // 上游失败 → 让卡片显示原因。抛出去 magpie 只会记成「读取失败」。
          if (isAuthFailure(error)) return { error: "登录已失效，请重新登录", windows: [] }
          return { error: String(error?.message ?? error), windows: [] }
        }

        return u
      },

      // ═══ ⑥ 签到 ═══════════════════════════════════════════════════
      async checkin(getAuth, provider) {
        const auth = await getAuth()
        if (!auth) return { outcome: "failed", message: "未登录" }

        const account = uidOf(auth)
        if (!account) return { outcome: "failed", message: "凭据缺少账号指纹" }

        const key = `${provider?.id || PROVIDER}\n${account}`
        return checkinLock.run(key, async () => {
          // 签到/奖励全是 v1 签名请求：没有登记好的设备身份，连状态都读不到。
          // 这里只读本机安装记录（插件自己生成的公钥/私钥），不碰桌面端任何凭据。
          //
          // ⚠ 记录键会变：`uidOf()` 优先用 `auth.uid`，而续期钩子会把 uid 从
          //   「凭据指纹」迁到「accountScope 指纹」（稳定锚点）。迁移后旧键下的
          //   记录还在，新键下没有 —— 只按 uid 找会得到「未注册设备」，
          //   而推理面明明能用（真机：签到报错、推理 200）。
          //
          //   而且 oauth 型登录态**不存 `accountScope`**（magpie 只留
          //   `type/refresh/access/expires/accountId/uid/metadata`），所以拿不到
          //   就只能现问一次 profile —— 签到是每天一次的动作，多一个请求可以接受。
          let installation = readInstallation(account)
          if (!installation?.installationId) {
            let scope = String(auth?.accountScope ?? "").trim()
            if (!scope) {
              try {
                const profile = await fetchProfile(auth, { fetchImpl })
                scope = String(profile?.account?.uuid ?? "").trim()
              } catch {
                // 拿不到 profile 就走「未注册」的失败说明，不编造
              }
            }
            if (scope) installation = findInstallationByScope(scope)
          }
          if (!installation?.installationId || !installation?.privateKey) {
            return {
              // ⚠ 不能用 `inactive`（HOOKS 二：inactive = 「没有签到活动」）——
              // 真实原因是「设备身份没注册」，宿主会把它写进 plugin-checkin.json 显示成无活动。
              outcome: "failed",
              message:
                "签到需要已注册的设备身份：该账号尚未完成设备注册，因此不发送任何请求" +
                "（先发一次模型请求完成设备注册；数据面不受影响）",
            }
          }

          const identity = {
            installationId: String(installation.installationId),
            sign: (canonical) => signCanonical(identityKeyOf(installation), canonical),
          }
          const daily = createDailyActivity({
            // ⚠ 形状适配层：`src/activity.mjs` 要的是 `{ status, body }`（它按状态码分流
            //   409 = 今天已领），而 `src/phanthy-api.mjs` 的 `request()` 只返回解析后的 body
            //   （非 2xx 会抛 ApiError，带 status/body）。不转换的话 `classifyClaim` 拿到的是
            //   body、`status` 恒为 undefined ⇒ 领取永远落 failed（审计 R-05 暴露出的接线错位）。
            request: async (options) => {
              try {
                const body = await phanthyRequest({ ...options, fetchImpl })
                return { status: 200, body }
              } catch (error) {
                if (!Number.isFinite(Number(error?.status)) || Number(error.status) === 0) throw error
                return {
                  status: Number(error.status),
                  body: error.body ?? { error: { code: error.code, message: error.message } },
                }
              }
            },
            now: () => Date.now(),
          })

          /**
           * 「今天这条已经发了」→ 用 `claimed`，不是 `done`。
           *
           * 为什么（2026-11-09 真机对照）：
           *
           *   workbuddy（绿灯）: { outcome:"claimed", credit:100, streak:41, claimed:"…" }
           *   本插件（黄灯）    : { outcome:"done",    credit:300, streak:2 }
           *
           * 宿主只把 `{outcome, credit, streak, message, until}` 转给 Go，
           * `claimed` 时间戳是 Go 在 `outcome === "claimed"` 时**自己补**的。
           * `done` 没有时间戳 ⇒ magpie 无法断言「这 300 分是今天的」⇒ 只能渲染成
           * 黄灯「回复已签到，但它的签到日可能…」，哪怕 `credit` 已经给了。
           */
          const claimedFrom = (rewards, message) => {
            const reward = dailyLoginReward(rewards)
            if (!reward) return null
            const credit = Number(reward.points ?? reward.credit ?? 0)
            const streak = dailyLoginStreak(rewards)
            return {
              outcome: "claimed",
              ...(Number.isFinite(credit) && credit > 0 ? { credit } : {}),
              ...(Number.isFinite(streak) && streak > 1 ? { streak } : {}),
              message,
            }
          }

          // ⚠ 0.1.0 起**不再要求 `PHANTHY_ALLOW_CHECKIN=1`**。
          //
          //   那个闸门和 `PHANTHY_ALLOW_LOCAL_IMPORT` / `PHANTHY_ALLOW_DEVICE_REGISTER`
          //   是同一个错：**magpie 是独立进程**，用户在 shell 里设的环境变量它看不到。
          //   于是「签到」这个功能对所有人都是死的 —— 点「立即签到」只会看到
          //   「自动领取默认关闭」。
          //
          //   而「真实领取」本身是安全的：`POST .../daily-login/claim` 用
          //   `daily:<installationId>:<day>` 做幂等键，同一天重复调用只会命中同一条
          //   （服务端回 409，我们映射成 `claimed`）。官方桌面端启动时也是直接领。
          //
          //   顺序仍然是「先读状态、已经有就不再发请求」—— 那能省掉一次 POST，
          //   只是它不是「安全闸门」，是「省一次请求」。
          const state = await daily.status(auth, identity)
          if (state.outcome === "ok") {
            const already = claimedFrom(state.rewards, "今日已签到")
            if (already) return already
          }
          // 读不到状态不等于失败：直接往下走 claim，让服务端说了算

          const result = await daily.claim(auth, identity)
          if (result.outcome === "signIn") throw asSignInExpired("登录已失效，请重新登录")
          // 真正领取之后：
          //   · `claimed` = 刚领到，`result.credit` 就是这次给的
          //   · `done`    = 409 今天已领，`reconcileCheckin` 拿不到金额 ——
          //                再读一次状态，把今天那条奖励的 `points` / 连续天数补上，
          //                否则卡片只显示「已签到」没有金额（黄灯）。
          if (result.outcome === "claimed" || result.outcome === "done") {
            let credit = result.credit
            let streak = result.streak
            if (result.outcome === "done" && !(Number.isFinite(credit) && credit > 0)) {
              const recheck = await daily.status(auth, identity).catch(() => null)
              if (recheck?.outcome === "ok") {
                const reward = dailyLoginReward(recheck.rewards)
                const points = Number(reward?.points ?? reward?.credit ?? NaN)
                if (Number.isFinite(points) && points > 0) credit = points
                const days = dailyLoginStreak(recheck.rewards)
                if (Number.isFinite(days) && days > 1) streak = days
              }
            }
            return {
              outcome: "claimed",
              ...(Number.isFinite(credit) && credit > 0 ? { credit } : {}),
              ...(Number.isFinite(streak) && streak > 1 ? { streak } : {}),
              message: result.outcome === "claimed" ? result.message || "今日签到完成" : "今日已签到",
            }
          }
          if (result.outcome === "inactive") {
            return { outcome: "failed", message: "设备身份不可用，未发送领取请求" }
          }
          return {
            outcome: "failed",
            message: `签到失败${result.code ? `（${result.code}）` : ""}`,
          }
        })
      },
    },

    // ═══ ⑦ 每账号的模型目录 ═══════════════════════════════════════
    provider: {
      id: PROVIDER,

      async models(provider, { auth } = {}) {
        const fallback = staticModels()
        if (!auth || !bearerOf(auth)) return fallback

        // 缓存 key 必须是「谁的数据」：凭据指纹 + 账号作用域。同一账号换 token 也不能串，
        // 不同账号（不同 accountScope）更不能共用目录/额度缓存。
        const scope = String(auth?.accountScope ?? readInstallation(String(uidOf(auth) ?? ""))?.accountScope ?? "")
        const scopeTag = scope ? fingerprint(scope) : "noscope"
        // 文件名只能是安全字符：作用域用指纹，账号部分再过滤一遍
        const accountTag = String(uidOf(auth) ?? fingerprint(bearerOf(auth))).replace(/[^A-Za-z0-9._-]/g, "_")
        const cacheKey = `${scopeTag}-${accountTag}`
        try {
          return await catalogCache.read(cacheKey, async () => {
            const catalog = await fetchCatalog(auth, { fetchImpl })
            const { models } = catalogEntries(catalog)
            // 目录成功但一条可用都没有 → 抛出去，交给下面的降级（不要缓存空表）
            if (Object.keys(models).length === 0) throw new Error("模型目录为空")
            return models
          })
        } catch (error) {
          // 登录被拒 → 标记账号（这是唯一该抛 signIn 的分支）
          if (isAuthFailure(error)) throw asSignInExpired("登录已失效，请重新登录")
          // 上游抖动 / 形状不符 → 上次快照 → 静态表（顺序不能反，快照才代表这个账号）
          const snapshot = catalogCache.lastSnapshot(cacheKey)
          return snapshot ?? fallback
        }
      },
    },

    // ═══ ⑧ 每请求加头 ═════════════════════════════════════════════
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== PROVIDER || !input?.sessionID) return
      output.headers[`x-${PROVIDER}-session`] = String(input.sessionID).slice(0, 128)
    },
  }

  // ── 内部实现（不导出：导出会破坏「入口只有一个函数」的契约）────────────
  // 额度卡片的实现已搬进 `src/usage-windows.mjs`（AGENTS 坑 18：入口只做装配）。

  /**
   * 聊天通道的请求器：把「超时 / 调用方取消」分类清楚（ERROR-CODES R8）。
   *
   * 不包装的后果：`AbortSignal.timeout` 触发时 `fetch` 抛 `TimeoutError`（Node）
   * 或 `AbortError`，裸异常直接进聊天通道，宿主既不敢换号也不知道该退避多久。
   */
  async function callUpstream(send, { callerSignal, timeoutSignal } = {}) {
    try {
      return await send()
    } catch (error) {
      const name = String(error?.name ?? "")
      const isAbort = name === "TimeoutError" || name === "AbortError"
      // 宿主自己传了 signal 且已 abort（切会话 / 用户点停止）：这是取消，不是超时。
      if (!isAbort || (callerSignal?.aborted && !timeoutSignal)) throw error
      const seconds = Math.round(TIMEOUT.stream / 1000)
      throw new ApiError(
        `上游 ${seconds} 秒内没有返回响应头（插件侧流式硬限），已按 504 交给宿主` +
          `（error=${name || "unknown"}${error?.message ? `: ${String(error.message).slice(0, 120)}` : ""}）`,
        { status: 504, code: "upstream_timeout" },
      )
    }
  }

  /**
   * 非登录问题的 401/403 补 `X-Magpie-Sign-In: kept`（ERROR-CODES R5）。
   *
   * 为什么必须做：上游对**单个模型**回 401（比如「该模型未开通」）时，宿主会把
   * 整个账号标成登录失效 —— 一次就能把用户所有模型打掉。真·登录失效（正文提到
   * token/session/登录）保持原样，交给宿主按 401 处理。
   */
  async function withSignInHint(res) {
    const status = Number(res?.status)
    if (status !== 401 && status !== 403) return res

    let text = ""
    try {
      text = await res.clone().text()
    } catch {
      text = ""
    }
    if (isLoginBroken(status, text)) return res

    const headers = new Headers(res.headers)
    headers.set("x-magpie-sign-in", "kept")
    return new Response(text === "" ? null : text, {
      status,
      statusText: res.statusText,
      headers,
    })
  }

  /** 从安装记录还原身份私钥（v1 canonical 用它签；只在签名的那一刻取） */
  function identityKeyOf(installation) {
    if (!installation?.privateKey) {
      throw new ApiError("设备安装记录缺少私钥 —— 这是插件自己的状态问题，重新登录可重建（鉴权未失效）", {
        status: 502,
        code: "internal_error",
      })
    }
    return importPrivateKey(installation.privateKey)
  }

  /**
   * 从安装记录还原 **inference（sidecar 会话）**私钥。
   *
   * 12 段 `desktop-inference-v2` 证明用它签，不是 identity —— 2026-11-09 真机实测：
   * inference 私钥签 → HTTP 200 出模型输出；identity 私钥签 → 401/403。
   * 三把密钥的分工见 `src/device-key.mjs` 文件头。
   */
  function inferenceKeyOf(installation) {
    if (!installation?.inferencePrivateKey) {
      throw new ApiError(
        "设备安装记录缺少 inference 私钥 —— 重新跑一次设备注册会补齐（鉴权未失效）",
        { status: 502, code: "internal_error" },
      )
    }
    return importPrivateKey(installation.inferencePrivateKey)
  }
}

// ⚠ 入口文件不要导出 helper 函数，否则会被当插件调用
export const _internal = {
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  SDK,
  MODELS,
  staticModels,
  ANTHROPIC_VERSION,
}