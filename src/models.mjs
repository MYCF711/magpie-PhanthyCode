// src/models.mjs —— 模型目录：过滤、降级、以及三个最容易错的字段
//
// 这个文件在四个真实插件里都有（4/4），因为 `provider.models` 是最容易「看起来对、
// 实际错」的钩子。下面每一条都是实测踩出来的，不是设计偏好。

import { BASE, SDK } from "./context.mjs"
import { contextOf as lookupContext } from "./model-context.mjs"

/**
 * 默认条目工厂：和 `context.mjs` 的 `staticModels()` 造出来的形状完全一致。
 *
 * ⚠ **不写 `cost`**（AGENTS 坑 2）。`cost` 是**美元列表价**语义，而云端目录只给
 * credits/百万 token；把 credits 换算成美元没有依据，写成 `{input:0,output:0}`
 * 又等于对全世界宣称「这些模型列表价 $0」—— 会被当成免费模型反复派发。
 * 没有可证实的美元价格就不写这个字段（宿主不会因此崩，只是不显示金额）。
 * 同理：`free` 只在厂商自己声明 0 价时写，不从 `rate` 反推。
 *
 * ⚠ **`limit` 只写 `context`**（HOOKS 十一之三表格 + CHECKLIST A-8）：
 *   `limit.output` 以前写死过一个没人验证过的上限，那是猜的数字。`limit` 里缺失/为 0 的项
 *   宿主会自己去查模型库 —— 所以宁可不写，也不填一个没人验证过的上限。
 */
export function defaultEntry(id, name, vision, opts = {}) {
  const { rate = 0, free = false, context } = opts
  return {
    id,
    name,
    api: { id, url: BASE, npm: SDK },
    status: "active",
    ...(typeof context === "number" ? { limit: { context } } : {}),
    capabilities: {
      temperature: true,
      reasoning: true,
      toolcall: true,
      attachment: !!vision,
      // HOOKS 十一之三：五个模态键必须显式写布尔。省略 image ≠ text ——
      // 宿主会拿 models.dev 的裸 id 投票补，同名模型在别家标过 image 就会被当成能收图。
      input: { text: true, image: !!vision, audio: false, video: false, pdf: false },
      output: { text: true },
    },
    // free 与 rate 不会同时出现：rate 只在 > 0 时写，free 只在确认为真时写
    ...(free ? { free: true } : {}),
    ...(!free && Number(rate) > 0 ? { rate: Number(rate) } : {}),
  }
}

/**
 * 倍率换算：上游给的是「积分/百万 token」，magpie 要的是倍数。
 *
 * ⚠ **3000 是实测值，不是猜的**（2026-11-09 官方客户端模型列表 vs 目录 pricing 逐条对表）：
 *
 *   deepseek-v4.1-flash  300 → 0.10x      glm-5.2          1140 → 0.38x
 *   glm-5.3-flash        120 → 0.04x      kimi-k2.7-code    920 → 0.31x
 *   kimi-k3             3000 → 1.00x      Phana-5.5o       2000 → 0.67x
 *   Phana-5.5s          1000 → 0.33x      Phano-6a         5000 → 1.67x
 *   Phanthy-fast           0 → 0.00x      Phanthy-pro      1000 → 0.33x
 *
 * 12 条全中。早期这里写 2000 是**错的**（deepseek 会算成 0.15x）。
 */
export const MULT_BASE = 3000

/** 不像 chat 模型的 id：embedding / rerank / 语音 —— 列出来选中必报错 */
const NOT_CHAT = /embed|rerank|tts|whisper/i

/**
 * 生图模型的 id 特征（与 magpie 的 `catalog.DrawsID` 对齐的主要几个词）。
 * 注意 `gemini-*-image` 与 `gpt-5-image` **不在此列** —— 它们在 chat 里回图，是正经 chat 模型。
 */
const IMAGE_LIKE = /(^|[-_/])(image|imagen|imagine|dall-e|flux|seedream|cogview|sdxl|stable-diffusion|wanx|kolors|hidream|banana|sensenova-u1)/i

/**
 * **要不要把生图模型也列进 models？默认不列。**
 *
 * magpie 0.1.1707 起支持「插件提供图像模型」：id 命中 `catalog.DrawsID` 且
 * `catalog.ImagesAPI`、且这个模型在 `@ai-sdk/openai-compatible` 上，就会被列进
 * Settings 的「图像生成」选择器，请求走 `/v1/images/generations`。
 *
 * 但 `pluginCatalog` **不会**把它们从模型列表里摘掉 —— 列出来 = chat 列表里多一条
 * 选不得的条目（用户选中 → 400）。所以这是个取舍，不是对错：
 *
 *   想供图 → 把它设成 `true`，并且在条目上把 `capabilities.output` 写成
 *            `{ text: false, image: true }`、`capabilities.input` 照实写
 *   只想干净 → 保持 `false`（默认）
 *
 * 三个判据、以及为什么 `gemini-*-image` 不算，见 HOOKS.md「十一之三」。
 */
const LIST_IMAGE_MODELS = false

/**
 * 上游给的模型能不能被用户真正选中。
 * 实测：有的平台「注册表」有 26 个、真正能调的只有 9 个 —— 比少给更糟的是多给。
 */
export function isUsable(m) {
  const id = String(m?.id ?? "")
  if (!id) return false
  if (NOT_CHAT.test(id)) return false
  if (!LIST_IMAGE_MODELS && IMAGE_LIKE.test(id)) return false
  // VIP / 锁定：选中必报错，直接不列
  const tags = Array.isArray(m?.tags) ? m.tags : []
  if (tags.some((t) => /vip|lock|pay|premium/i.test(String(t?.value ?? t)))) return false
  return true
}

/**
 * 价格三分支 —— **`free` 不能从 `rate` 反推**。这是全模板最容易错的一处。
 *
 * 实测（HOOKS.md 十一之二）：`rate === 0` 的 51 条里，只有 13 条真免费，
 * 另外 38 条是「套餐内不按次计费」—— 照样吃套餐额度。标成 free 会让
 * Free first 一直派到它们身上。
 *
 *   input_points > 0   → 有倍率，free 不设
 *   input_points === 0 → 厂商声明免费 → free: true，且不给 rate
 *   input_points 缺失  → 价格未知 → **不列**（不猜，也不谎标免费）
 */
export function priceOf(pointEntry) {
  const raw = pointEntry?.inputPoints
  const known = raw != null && String(raw).trim() !== "" && Number.isFinite(Number(raw))
  if (!known) return { known: false }
  const n = Number(raw)
  return n === 0 ? { known: true, free: true, rate: 0 } : { known: true, free: false, rate: n / MULT_BASE }
}

/**
 * 上下文窗口：**查 magpie 的模型库，不要填保守值**。
 *
 * 填错的两种后果，实测都发生过：
 *   - 填大了：上游 400，而这个 400 会被当成「模型不可用」
 *   - 填小了：agent 认为「放不下」，长输入被拒 —— 用户以为是模型的锅
 *
 * 早前一律填 256K，实际是 1M。真实窗口去 magpie 自己的模型库查 —— 实现见
 * `src/model-context.mjs` 的 `createModelContext()` / `contextOf()`。
 *
 * 查不到就返回 undefined：`defaultEntry` 不会写 `limit`，宿主用它自己的默认。
 * **不猜**一个数字 —— 猜大了上游 400，猜小了 agent 提前压缩。
 */
export function contextOf(modelId, opts = {}) {
  return lookupContext(modelId, opts)
}

/**
 * 组装 magpie 要的模型条目。
 *
 * `degraded` 是「部分成功」的表达，**三种降级方向必须分清**：
 *   ① 计费接口整个挂了（pointsOk=false）  → 不过滤，宁愿没有倍率也别让列表空掉
 *   ② 计费接口成功、但这条没价格         → 不列（用户选了不知道花多少）
 *   ③ 模型列表整个挂了                   → 不返回空 map，让调用方退回上次快照
 *
 * @param {{id:string,name:string,vision?:boolean}[]} live  上游模型列表
 * @param {Map<string,{inputPoints?:number}>} points        计费（可为空）
 * @param {(id:string,name:string,vision:boolean,opts:object)=>object} entry 显示条目工厂
 */
export function buildModels(live, points, entry = defaultEntry) {
  const pointsOk = points instanceof Map ? points.size > 0 : Object.keys(points || {}).length > 0
  const out = {}
  let droppedUnknownPrice = 0

  for (const m of live || []) {
    if (!isUsable(m)) continue
    const pid = m.pointId ?? m.id
    const p = points instanceof Map ? points.get(pid) : points?.[pid]
    const price = priceOf(p)

    // ② 价格未知 → 不列（只在「计费接口本身是成功的」前提下）
    if (pointsOk && !price.known) {
      droppedUnknownPrice++
      continue
    }

    out[m.id] = entry(m.id, m.name, !!m.vision, {
      rate: price.known ? price.rate : 0,
      free: !!price.free,
      context: contextOf(m.id),
    })
  }

  return { models: out, pointsOk, droppedUnknownPrice }
}

// ── live models 通用适配层 ──────────────────────────────────────────

/** 上游标识优先取 code；没有 code 的上游通常直接把 id 当请求标识 */
const upstreamCodeOf = (record) => record?.code ?? record?.id

/**
 * 给 live models 分配稳定且唯一的展示 id。
 * 同一个基础 id 按出现顺序得到原值、-2、-3；已占用的 slug 也会跳过。
 * 返回新数组和新条目，code 始终保留真正发给上游的标识。
 */
export function assignSlugs(records, { idOf = upstreamCodeOf, codeOf = upstreamCodeOf } = {}) {
  const counts = new Map()
  const used = new Set()
  return Array.from(records ?? [], (record) => {
    const code = codeOf(record)
    const base = String(idOf(record) ?? code ?? "")
    let count = (counts.get(base) ?? 0) + 1
    let slug = count === 1 ? base : `${base}-${count}`
    while (used.has(slug)) {
      count++
      slug = `${base}-${count}`
    }
    counts.set(base, count)
    used.add(slug)
    return { ...record, id: slug, code }
  })
}

/**
 * 建立 slug/code 双向索引。
 * bySlug 是「展示 id → 上游 code」；byCode 是「上游 code → 展示 id」。
 * 两者都是 Map；code 重复时，反向索引保留出现顺序中的首个展示 id。
 */
export function makeModelIndex(records, keyOf = upstreamCodeOf) {
  const bySlug = new Map()
  const byCode = new Map()
  for (const record of records ?? []) {
    const slug = record?.id
    const code = keyOf(record)
    if (slug == null || code == null) continue
    bySlug.set(slug, code)
    if (!byCode.has(code)) byCode.set(code, slug)
  }
  return { bySlug, byCode }
}

/** 已知展示 id 翻译成上游 code；未知 id 原样返回，便于调用方自行处理 */
export function upstreamModelId(id, records) {
  const { bySlug } = makeModelIndex(records)
  return bySlug.has(id) ? bySlug.get(id) : id
}

// 只继承宿主需要的静态描述；价格、名称和账号可见范围都以 live 为准
const STATIC_METADATA = ["limit", "capabilities", "api"]

/**
 * 按相同 id 给 live 条目补静态元数据，输出仍只包含 live 中的模型。
 * live 已给出 capabilities 时，只补齐 input/output 的模态键，且 live 的显式
 * 布尔值优先；其它 capabilities 子字段和 limit 仍不做深合并，避免猜大权限。
 * 未知模型也不会拿第一条兜底。
 */
export function mergeModelMetadata(live, fallback) {
  const fallbackById = new Map()
  for (const record of fallback ?? []) {
    if (record?.id != null && !fallbackById.has(record.id)) fallbackById.set(record.id, record)
  }
  return Array.from(live ?? [], (record) => {
    const base = fallbackById.get(record?.id)
    const merged = { ...record }
    if (!base) return merged
    for (const key of STATIC_METADATA) {
      if (key === "capabilities" && merged[key] !== undefined && base[key] !== undefined) {
        const capabilities = { ...merged[key] }
        for (const modality of ["input", "output"]) {
          const fallbackModalities = base[key]?.[modality]
          if (fallbackModalities === undefined) continue
          const liveModalities = merged[key]?.[modality]
          capabilities[modality] = liveModalities === undefined
            ? fallbackModalities
            : { ...fallbackModalities, ...liveModalities }
        }
        merged[key] = capabilities
      } else if (merged[key] === undefined && base[key] !== undefined) {
        merged[key] = base[key]
      }
    }
    return merged
  })
}
