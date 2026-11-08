// src/catalog.mjs —— 云端模型目录（`/api/phanthy_code/models`）的解析与降级
//
// 这个端点是「账号能看到什么模型」的唯一权威来源，服务端的目录带
// `schema_version` 版本号：版本不是 1 就**不要猜字段**，直接当失败处理。
//
// 响应形状（静态观察所得，字段名按原样）：
//   { schema_version, default_model, models: [{
//       id, alias, label, description, context_window_tokens, tier, recommended,
//       pricing: { input_credits_per_million_tokens, output_credits_per_million_tokens },
//       capabilities: { effort, max_effort, gpt_reasoning_effort, glm_reasoning_effort },
//   }] }
//
// 三条降级方向（与 `src/models.mjs` 的三态一致）：
//   ① 整个接口失败        → 调用方退回静态表 / 上次快照，**不返回空列表**
//   ② 接口成功但单条缺 id  → 不列这一条（不猜）
//   ③ 登录失效            → 由调用方抛 `signIn: "expired"`
//
// ⚠ 价格是 credits/百万 token，不是美元：magpie 的 `cost` 字段是美元语义，
//   所以这里不把 credits 填进 `cost`（填了会让「花多少」显示成错的数量级）。
//   目录里带的 credits 原样放在条目的 `pricing` 上，宿主会忽略未知字段。
//
// 字段级证据（`claude-sidecar.exe` 的目录映射，2026-11-08 逆向）：
//   · 三档 `max_effort` / `gpt_reasoning_effort` / `glm_reasoning_effort` 官方按
//     `typeof v === "boolean"` 消费（@108098822 / @108098885 / @108098940）——
//     服务端下发布尔，按字符串读会得到 `""`，三档全部丢失。
//   · 上下文窗口的回退链是 `context_window → context_window_tokens → contextWindow`，
//     且只接受 16000..1e7 的整数（@108104990）。

import { defaultEntry, isUsable } from "./models.mjs"

/** 模型目录端点 */
export const CATALOG_PATH = "/api/phanthy_code/models"

/** 目录统计端点（请求量 / 成功率，只用于展示） */
export const CATALOG_STATS_PATH = "/api/phanthy_code/models/stats"

/** 服务端目录的结构版本；不是这个值就当失败 */
export const CATALOG_SCHEMA_VERSION = 1

/** 上下文窗口的回退链（顺序即优先级，官方同一顺序） */
export const CONTEXT_KEYS = ["context_window", "context_window_tokens", "contextWindow"]

/** 官方只认这个区间的整数窗口（太小/太大都是脏数据，不猜） */
export const CONTEXT_MIN = 16_000
export const CONTEXT_MAX = 10_000_000

/** 目录形状不对（不是 HTTP 错误，是「字段对不上」） */
export class CatalogShapeError extends Error {
  constructor(message, { body } = {}) {
    super(message)
    this.name = "CatalogShapeError"
    this.code = "catalog_shape_invalid"
    this.body = body
  }
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * 上下文窗口：按官方回退链取第一个合法整数。
 * 全都不合法 → `undefined`（调用方不写 `limit`，宿主用自己的默认，不猜）。
 */
export function contextWindowOf(raw) {
  for (const key of CONTEXT_KEYS) {
    const n = Number(raw?.[key])
    if (!Number.isInteger(n)) continue
    if (n < CONTEXT_MIN || n > CONTEXT_MAX) continue
    return n
  }
  return undefined
}

/** 官方按布尔消费的能力位：只有明确的 `true` 才算有这个能力 */
function flagOf(value) {
  return value === true
}

/**
 * 积分 → magpie 的倍率（卡片上那个 `0.38x`）。
 *
 * 公式来自实测对表（2026-11-09，官方客户端模型列表 vs 目录 pricing）：
 *
 *   rate = input_credits_per_million_tokens / 3000
 *
 * 12 条模型逐条命中：300→0.10、1140→0.38、120→0.04、920→0.31、
 * 3000→1.00、2000→0.67、1000→0.33、5000→1.67、0→0.00。
 * 3000 积分/百万 token 是「1 倍率」的基准价。
 *
 * 返回 `undefined` 表示目录里没有可用的价格（不写 `rate`，宿主按「未给倍率」处理）。
 * 返回 `0` 只可能是「官方标价就是 0」或「价格小到两位小数下看不出来」——
 * 后者**不是免费**，所以 `free` 必须由 `inputCreditsPerMillion === 0` 单独判，
 * 不能拿这个四舍五入后的 0 去推（坑 2）。
 */
export function rateOf(model) {
  const input = Number(model?.pricing?.inputCreditsPerMillion)
  if (!Number.isFinite(input) || input < 0) return undefined
  // 保留两位小数：0.30666… 官方显示 0.31
  return Math.round((input / 3000) * 100) / 100
}

/**
 * 官方是否**明确标了 0 积分**（= 免费）。
 *
 * ⚠ 不能用 `rateOf(...) === 0` 代替：极小但非零的价格四舍五入后也是 0，
 *   那种模型照样吃额度，标成免费会被 Free first 一直派发（HOOKS 十一之二）。
 */
export function isFreeByPrice(model) {
  const input = Number(model?.pricing?.inputCreditsPerMillion)
  return Number.isFinite(input) && input === 0
}

/**
 * 解析目录响应。
 *
 * @param {unknown} body
 * @returns {{schemaVersion:number, defaultModel:string, models:Array<object>}}
 */
export function parseCatalog(body) {
  if (!body || typeof body !== "object") {
    throw new CatalogShapeError("模型目录不是对象", { body })
  }
  const schemaVersion = Number(body.schema_version)
  if (schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new CatalogShapeError(
      `模型目录的 schema_version 是 ${body.schema_version ?? "缺失"}，` +
        `这个插件只认 ${CATALOG_SCHEMA_VERSION} —— 字段含义变了就不能猜`,
      { body },
    )
  }
  if (!Array.isArray(body.models)) {
    throw new CatalogShapeError("模型目录的 models 不是数组", { body })
  }

  const models = []
  for (const raw of body.models) {
    const id = trimmed(raw?.id)
    // ② 单条缺 id → 不列（不猜）
    if (!id) continue
    const capabilities = raw?.capabilities && typeof raw.capabilities === "object" ? raw.capabilities : {}
    models.push({
      id,
      alias: trimmed(raw?.alias),
      name: trimmed(raw?.label) || trimmed(raw?.alias) || id,
      description: trimmed(raw?.description),
      context: contextWindowOf(raw),
      tier: trimmed(raw?.tier),
      recommended: raw?.recommended === true,
      pricing: {
        inputCreditsPerMillion: Number(raw?.pricing?.input_credits_per_million_tokens) || 0,
        outputCreditsPerMillion: Number(raw?.pricing?.output_credits_per_million_tokens) || 0,
      },
      capabilities: {
        effort: flagOf(capabilities.effort),
        maxEffort: flagOf(capabilities.max_effort),
        gptReasoningEffort: flagOf(capabilities.gpt_reasoning_effort),
        glmReasoningEffort: flagOf(capabilities.glm_reasoning_effort),
      },
    })
  }

  return { schemaVersion, defaultModel: trimmed(body.default_model), models }
}

/**
 * 目录 → magpie 的模型条目。
 *
 * 只输出目录里真的有的模型，不用「第一条兜底」补未知 id；
 * `limit` 只在服务端给了合法上下文时才写 —— 不猜窗口大小。
 *
 * ⚠ 必须过 `isUsable`（AGENTS 坑 20）：目录里若有 embedding / rerank / tts / 生图行，
 *   直接列进 chat 列表 = 用户选中后报 400。过滤口径集中在 `src/models.mjs`，
 *   这里不再各写一份（早期版本漏了这一步，`LIST_IMAGE_MODELS` 因此在运行时从未生效）。
 *
 * ⚠ `vision` 恒为 `false`：目录响应里没有已证实的「能否收图」字段（`capabilities`
 *   只有四个思考档位）。坑 25 要求显式布尔，所以写 `false`（保守：不发图）而不是
 *   省略。这是已知缺口，登记在 CHECKLIST.md 的 A-14 备注里。
 *
 * @param {ReturnType<typeof parseCatalog>} catalog
 * @param {{entry?: Function, usable?: (m: object) => boolean}} [options]
 * @returns {{models: Record<string, object>, withoutContext: number, filteredOut: number}}
 */
export function catalogEntries(catalog, { entry = defaultEntry, usable = isUsable } = {}) {
  const models = {}
  let withoutContext = 0
  let filteredOut = 0

  for (const model of catalog?.models ?? []) {
    if (!usable(model)) {
      filteredOut++
      continue
    }
    const options = {}
    if (model.context !== undefined) options.context = model.context
    const built = entry(model.id, model.name, false, options)
    const rate = rateOf(model)
    models[model.id] = {
      ...built,
      // 服务端说会思考才给 reasoning；defaultEntry 默认 true，这里按目录覆盖
      capabilities: { ...built.capabilities, reasoning: model.capabilities.effort === true },
      description: model.description || undefined,
      // 倍率：卡片上那个 `0.38x`（AGENTS 十一之二）。
      // 没给倍率（目录里没有 pricing）就不写这个字段 —— 别用 0 冒充「免费」。
      ...(rate === undefined ? {} : { rate }),
      // ⚠ 坑 2：`rate: 0` 的意思是「没给倍率」，**不是免费**，magpie 不会从 rate 推 free。
      //   所以「0 积分」必须**显式**标 free，否则 Free-first 路由永远不派发它。
      //   判据是原始积分严格等于 0，不是四舍五入后的 rate（见 isFreeByPrice）。
      ...(isFreeByPrice(model) ? { free: true } : {}),
    }
    if (model.context === undefined) withoutContext++
  }

  return { models, withoutContext, filteredOut }
}
