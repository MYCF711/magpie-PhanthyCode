// examples/split/index.mjs —— 装配用的入口：**只有装配，没有实现**
//
// 这是「插件长大后」的形态：根 `index.mjs` 从 535 行缩到 40 行，
// 每一项钩子在自己的文件里。四个真实插件的 `index.mjs` / `src/` 行数对比见
// 根目录 AGENTS.md 的「五、长大之后」。
//
// 这里只演示三种典型形态（纯声明 / 异步取数 / 纯计算），其余五个钩子照同一规则搬：
//
//   config.mjs   ← 纯声明          （同类的还有 headers.mjs）
//   models.mjs   ← 异步取数 + 降级 （同类的还有 loader.mjs）
//   usage.mjs    ← 纯计算 + 归一化 （同类的还有 checkin.mjs）
//   methods.mjs  ← 登录流程（有状态、最长的一个）
//   refresh.mjs  ← 续期（必须串行）
//
// 搬的时候只改一处：把闭包里的外部变量收进 `c`。这样每个 hook 都是
// `makeXxx(c) → 钩子函数`，测试时换个 `c` 就能脱离宿主跑。
//
// ⚠ 这个示例**不进 npm 包**（package.json 的 files 白名单不含 examples），
//   它只是重构示范；真正的实现在根 `index.mjs` + `src/`。

import { PROVIDER, PROVIDER_NAME, BASE, SDK, ICON, REFRESH_LEAD_MS, staticModels } from "../../src/context.mjs"
import { catalogEntries } from "../../src/catalog.mjs"
import { fetchCatalog, fetchUsage as fetchCloudUsage, fetchWallet } from "../../src/phanthy-api.mjs"
import { makeConfig } from "./src/hooks/config.mjs"
import { makeModels } from "./src/hooks/models.mjs"
import { makeUsage } from "./src/hooks/usage.mjs"

/**
 * `c` 就是「这个插件知道的一切」。一次构造，传给每个工厂。
 *
 * 把三个上游调用也挂在这里（而不是让 hook 自己 import `../api.mjs`）的好处：
 * 测试里把它们换成假的，就能脱离网络跑完所有钩子。
 */
function contextOf(options = {}) {
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : globalThis.fetch
  return {
    PROVIDER,
    PROVIDER_NAME,
    BASE,
    SDK,
    ICON,
    staticModels,

    /** 这个账号能用的模型列表（目录 → 过滤后的条目，只保留 id/name/vision） */
    async fetchLiveModels(auth) {
      const catalog = await fetchCatalog(auth, { fetchImpl })
      const { models } = catalogEntries(catalog)
      return Object.values(models).map((m) => ({
        id: m.id,
        name: m.name,
        vision: m.capabilities?.input?.image === true,
      }))
    },

    /** 计费表：云端目录只给 credits/百万 token，没有点数表 → 返回空表 */
    async fetchPoints(_auth) {
      return {}
    },

    /** 额度：套餐名 + 积分用量（换算成 usage.mjs 想要的 used/total 形状） */
    async fetchUsage(auth) {
      const [usage, wallet] = await Promise.all([
        fetchCloudUsage(auth, { fetchImpl }),
        fetchWallet(auth, { fetchImpl }),
      ])
      const total = Number(wallet?.wallet?.total_points)
      const available = Number(wallet?.wallet?.available_points)
      const known = Number.isFinite(total) && Number.isFinite(available) && total > 0
      return {
        plan: String(usage?.plan?.name ?? ""),
        until: String(usage?.plan?.expires_at ?? ""),
        used: known ? Math.max(0, total - available) : 0,
        total: known ? total : 0,
        percentUsed: known ? Math.min(100, ((total - available) / total) * 100) : 0,
        resetsAt: "",
      }
    },
  }
}

export const PhanthyCodeAuthPlugin = async (_ctx, _options = {}) => {
  const c = contextOf(_options)

  return {
    config: makeConfig(c),

    auth: {
      provider: c.PROVIDER,
      icon: c.ICON, // ⚠ 图标要写两份，另一份是 package.json 的 magpie.icon
      maxConcurrency: 4,
      refreshLead: REFRESH_LEAD_MS,

      usage: makeUsage(c),

      // 其余五个钩子按 HOOKS.md 的章节搬进来（每个钩子的字段级契约都在那里）：
      // methods: makeMethods(c),
      // refresh: makeRefresh(c),
      // loader: makeLoader(c),
      // checkin: makeCheckin(c),
    },

    provider: {
      id: c.PROVIDER,
      models: makeModels(c),
    },

    // chat: { headers: makeHeaders(c) },
  }
}
