// src/catalog-union.mjs —— 厂商有两个模型目录时：合并、去重、保底
//
// 为什么需要它：不少厂商的模型列表不止一处来源 ——
//
//   • 客户端读的那份（WorkBuddy 的 `/v3/config`、很多家的 `/v1/models` 带 agent 段）
//   • 控制台 / 网页版那份（WorkBuddy 的 `/console/enterprises/personal/models`）
//
// 2026-11 实测 WorkBuddy：桌面客户端读的那份**更新慢**，控制台那份带完整的分角色元数据
// （上下文、倍率、思考档、能力），而且会先上新的模型。只读一份的后果不是报错，
// 是「插件里的模型比网页上少几个、倍率不对」—— 用户不会想到是插件的问题。
//
// 两处踩过的坑，这个模块把它们变成结构：
//
//   1. **谁优先**：两份都有同一个 id 时，用新的那份（控制台）的元数据，旧的那份只补
//      它没有的 id 和促销表。反过来会让倍率退回旧值。
//   2. **空目录不是空列表**：两份都读不到要抛，让调用方回退上次快照 / 静态表；
//      返回 `[]` 会被宿主当成「这家没有模型」，用户看到的是整个供应商消失。
//
// 本模块只做纯函数，不发请求、不认识任何厂商字段名。

/**
 * catalogRows 把一个目录页归一化成「有 id 的行」数组。
 *
 * 认三种形状（都实测过）：
 *   { models: [...] }              —— 客户端配置的形状
 *   { data: [...] }                —— 控制台的形状，常见包一层
 *   [{ ... }]                      —— 直接是数组
 *
 * 控制台的每一项可能把模型嵌在 `model` 里（`{ id, model: { id, ... } }`），
 * 内层优先合并。**认不出的一律丢掉，不猜 id** —— 猜出来的 id 会让一次请求
 * 打到不存在的模型上，报的是 404「模型不可用」，不是「目录解析失败」。
 *
 * @param {unknown} page
 * @returns {Array<Record<string, any>>}
 */
export function catalogRows(page) {
  const raw = Array.isArray(page?.models)
    ? page.models
    : Array.isArray(page?.data)
      ? page.data
      : Array.isArray(page)
        ? page
        : []
  const out = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const row = item.model && typeof item.model === "object" ? { ...item, ...item.model } : item
    if (typeof row.id === "string" && row.id) out.push(row)
  }
  return out
}

// isChatLike 判断一行能不能进聊天模型选择器。这些行只在控制台目录里出现，
// 客户端配置那份从不给它们 —— 所以这条过滤只该用在「多目录合并」的路径上，
// 单目录的兼容路径保持原样，别顺手把别人的列表改了。
const ALIASES = new Set(["auto", "default"])
const NON_CHAT_PREFIX = /^(nes-|completion-|codewise-)/
const MIN_OUTPUT_TOKENS = 256

/**
 * isChatLike 是一行是否属于「能对话的模型」。
 *
 * 挡五类：`auto` / `default` 这种路由别名、NES / 补全 / 代码改写这类专用小模型、
 * 输出上限 ≤256 的（不是聊天模型）、生成图模型的（`text-to-image`）、以及上游自己
 * 标了 `supportsExtra` 的附属行。
 *
 * @param {Record<string, any>} row
 * @returns {boolean}
 */
export function isChatLike(row) {
  const id = String(row?.id ?? "")
  if (ALIASES.has(id)) return false
  if (NON_CHAT_PREFIX.test(id)) return false
  if (row?.supportsExtra === true) return false
  if (Number(row?.maxOutputTokens) > 0 && Number(row.maxOutputTokens) <= MIN_OUTPUT_TOKENS) return false
  if (Array.isArray(row?.tags) && row.tags.includes("text-to-image")) return false
  return true
}

/**
 * mergeCatalogs 合并两份目录，返回可以拿去建模型列表的东西。
 *
 * `primary` 是新的那份（控制台 / 网页），`fallback` 是客户端读的那份。
 * 两者都可以是 null —— 只给一份时它既是主目录也是补集。
 *
 * `agents` 是「哪些 agent 段里的 id 算数」：默认 `["cli", "craft"]`，第一个是兼容
 * 路径用的（没有 primary 时只列它，保持和单目录时代一模一样）。
 *
 * @param {{
 *   primary?: unknown,
 *   fallback?: unknown,
 *   filter?: (row: Record<string, any>) => boolean,
 *   agents?: string[],
 * }} input
 * @returns {{
 *   ids: string[],
 *   rows: Array<Record<string, any>>,
 *   rowOf: Map<string, Record<string, any>>,
 *   promotions: any[],
 *   merged: boolean,
 * }}
 */
export function mergeCatalogs({ primary, fallback, filter = isChatLike, agents = ["cli", "craft"] } = {}) {
  if (!primary && !fallback) {
    throw new TypeError("mergeCatalogs: 至少给一个目录页（两份都读不到就走调用方的回退，不要返回空表）")
  }
  if (!Array.isArray(agents) || !agents.length) {
    throw new TypeError("mergeCatalogs: agents 至少要给一个 agent 名")
  }
  const pages = [primary, fallback].filter(Boolean)

  // 元数据：先铺 fallback，再让 primary 覆盖同 id 的字段。
  const rowOf = new Map()
  for (const page of [fallback, primary].filter(Boolean)) {
    for (const row of catalogRows(page)) {
      const was = rowOf.get(row.id)
      rowOf.set(row.id, { ...(was ?? {}), ...row })
    }
  }

  const ids = []
  const add = (id) => {
    if (typeof id !== "string" || !id || ids.includes(id)) return
    ids.push(id)
  }

  if (primary) {
    // 主目录在：它自己的行先上（控制台顺序就是网页上的顺序），然后按 agent 段
    // 补 fallback 引用的 id，最后把两份里剩下的可用行按出现顺序补进来。
    for (const page of [primary, fallback].filter(Boolean)) {
      for (const agent of page.agents ?? []) {
        if (!agents.includes(agent?.name)) continue
        for (const id of agent.models ?? []) {
          if (filter(rowOf.get(id) ?? { id })) add(id)
        }
      }
      for (const row of catalogRows(page)) if (filter(row)) add(row.id)
    }
  } else {
    // 没有主目录：只列兼容 agent 的那一份，一个 id 都不加 —— 兼容面不能因为
    // 这一次改动变宽。
    for (const agent of fallback?.agents ?? []) {
      if (agent?.name !== agents[0]) continue
      for (const id of agent.models ?? []) add(id)
    }
  }

  if (!ids.length) {
    throw new Error("mergeCatalogs: 目录里没有可用的聊天模型（调用方应回退上次快照，不要清空）")
  }

  const promotions = pages.map((p) => p?.modelPromotions).find(Array.isArray) ?? []
  return {
    ids,
    rows: ids.map((id) => rowOf.get(id) ?? { id }),
    rowOf,
    promotions,
    merged: Boolean(primary),
  }
}
