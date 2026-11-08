// tests/helpers/network-guard.mjs —— 测试期零出站守卫
//
// 背景：曾有一次缓存测试把注入参数写成 `{ fetchImpl }`（插件读 `_options.fetch`），
// 于是回落到全局 fetch，以一个假 token 真实发出了 401。这条守卫让同类错误立刻变红：
//   · 默认把 globalThis.fetch 换成一个抛错的桩；
//   · 需要真实网络的测试必须显式 `allowNetwork()`（目前没有任何测试需要）。
//
// 用法：package.json 的 test 脚本加 `--import ./tests/helpers/network-guard.mjs`。

const realFetch = globalThis.fetch
let blocked = 0

globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input ?? "")
  // 回环放行：模板自带的 loopback 测试要打 127.0.0.1，那不是出站
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url)) return realFetch(input, init)
  blocked += 1
  throw new Error(`测试禁止真实网络：${String(url).slice(0, 120)}（请注入 _options.fetch）`)
}

/** 显式放行真实网络（默认不调用；保留给将来有隔离环境的手工脚本） */
export function allowNetwork() {
  globalThis.fetch = realFetch
}

/** 已拦截次数（守卫自证用） */
export function blockedCount() {
  return blocked
}

/**
 * 清零计数 —— 只给「故意触发拦截」的自证测试用：
 * 否则守卫自测会在整套跑完后打印一行“拦截了 1 次”，把真实出站信号淹掉。
 */
export function resetBlocked() {
  blocked = 0
}

process.on("exit", () => {
  if (blocked > 0) process.stderr.write(`[network-guard] 拦截了 ${blocked} 次真实网络调用\n`)
})