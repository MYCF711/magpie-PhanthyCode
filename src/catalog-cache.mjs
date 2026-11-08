// src/catalog-cache.mjs —— 模型目录缓存（按账号隔离、TTL、单飞、失败降级）
//
// 为什么需要：`provider.models` 每个账号都会被调，卡片一刷新就打一次上游，
// 目录接口一抖动整张卡就空。这里做四件事，缺一条都会出事：
//   ① **按账号隔离**：key 是凭据指纹，文件名带账号 —— 宿主是同一进程跑所有账号；
//   ② **TTL**：成功缓存 10 分钟；失败只缓存 30 秒（接口抖一下不要卡死整页）；
//   ③ **单飞**：同 key 并发只打一次上游（模型列表 + 卡片同时刷新很常见）；
//   ④ **失败降级**：上游挂掉时返回**上次快照**，而不是空表 —— 空表等于「这家没模型」。
//
// 只存模型条目，不存 token、不存账号名。

import { fileOf, readJson as readJsonFile, writeJson as writeJsonFile } from "./store.mjs"

/** 目录缓存文件名：(plugin)-catalog-<provider>__<账号指纹>.json */
export function catalogFile(account, { siteId = "phanthycode" } = {}) {
  return fileOf("catalog", { siteId, account })
}

/**
 * @param {{
 *   ttlMs?: number,
 *   failTtlMs?: number,
 *   now?: () => number,
 *   siteId?: string,
 *   readJson?: Function,
 *   writeJson?: Function,
 * }} [options]
 */
export function createCatalogCache({
  ttlMs = 10 * 60_000,
  failTtlMs = 30_000,
  now = Date.now,
  siteId = "phanthycode",
  readJson = readJsonFile,
  writeJson = writeJsonFile,
} = {}) {
  /** key → { value } 或 { error }，带时间戳 */
  const memory = new Map()
  /** key → in-flight promise */
  const inflight = new Map()

  const fresh = (entry) => {
    if (!entry) return false
    const age = now() - entry.at
    return entry.ok ? age < ttlMs : age < failTtlMs
  }

  return {
    /**
     * 读缓存；没有/过期就 `compute()` 一次，并落盘做「上次快照」。
     * 上游失败**不**在这里吞掉 —— 由调用方决定要不要退回快照。
     */
    async read(key, compute) {
      const id = String(key)
      const hit = memory.get(id)
      if (fresh(hit)) {
        if (hit.ok) return hit.value
        throw hit.error
      }
      const running = inflight.get(id)
      if (running) return running

      const task = (async () => {
        try {
          const value = await compute()
          memory.set(id, { ok: true, value, at: now() })
          writeJson(catalogFile(id, { siteId }), { schemaVersion: 1, savedAt: now(), models: value })
          return value
        } catch (error) {
          memory.set(id, { ok: false, error, at: now() })
          throw error
        } finally {
          inflight.delete(id)
        }
      })()
      inflight.set(id, task)
      return task
    },

    /** 上次成功快照（读盘）；没有就 null。调用方据此决定退回快照还是静态表 */
    lastSnapshot(key) {
      const saved = readJson(catalogFile(String(key), { siteId }), null)
      const models = saved?.models
      return models && typeof models === "object" && Object.keys(models).length > 0 ? models : null
    },

    /** 显式清掉某个账号的内存缓存（登录态变化时用；磁盘快照保留作降级） */
    forget(key) {
      memory.delete(String(key))
    },

    /** 测试用：当前内存条目数 */
    size() {
      return memory.size
    },
  }
}
