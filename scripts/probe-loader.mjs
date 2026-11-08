// scripts/probe-loader.mjs —— 直接调插件 loader 的 fetch，复现 magpie 网关的 403
//
// 目的：网关上「phanthy/Phanthy-fast 403 request_not_authorized」，
//      但 scripts/probe-e2e.mjs 自己拼的请求是 200。差异一定在插件 loader 的实现里。
//      本脚本走**插件自己的代码路径**，把实际发出去的头打印出来对比。

import { readImportedAccess } from "../src/local-import.mjs"
import { fingerprint } from "../src/credential.mjs"
import { PhanthyCodeAuthPlugin } from "../index.mjs"
import { readInstallation } from "../src/device-key.mjs"

const BASE = "https://code.phanthy.com"
const MODEL = process.argv[2] ?? "Phanthy-fast"

const { access } = readImportedAccess()
const uid = fingerprint(access)
console.log(`token : len=${access.length} sha8=${uid.slice(0, 8)}`)
console.log(`uid   : ${uid}`)

const record = readInstallation(uid)
console.log(`安装记录:`)
if (!record) {
  console.log("  (无) —— 这个 uid 还没注册，loader 会现场注册")
} else {
  console.log(`  installationId    : ${record.installationId}`)
  console.log(`  accountScope      : ${record.accountScope}`)
  console.log(`  registeredAt      : ${record.registeredAt}`)
  console.log(`  hasInferenceToken : ${Boolean(record.inferenceToken)}`)
  console.log(`  三把公钥互异      : ${new Set([record.publicKey, record.devicePublicKey, record.inferencePublicKey]).size === 3}`)
}
console.log()

const plugin = await PhanthyCodeAuthPlugin({}, {
  fetch: async (url, init) => {
    const u = String(url)
    if (u.includes("/v1/messages")) {
      console.log("=== 实际发出的推理请求 ===")
      console.log(`  URL    : ${u}`)
      const h = new Headers(init?.headers ?? {})
      const order = []
      for (const [k, v] of h) {
        const lower = k.toLowerCase()
        if (lower === "authorization") order.push(`  ${k}: (len=${String(v).length})`)
        else if (lower === "x-phanthy-proof-signature") order.push(`  ${k}: ${String(v).slice(0, 20)}… (len=${String(v).length})`)
        else if (lower === "x-phanthy-desktop-session") order.push(`  ${k}: (len=${String(v).length}) ${String(v).slice(0, 24)}…`)
        else order.push(`  ${k}: ${v}`)
      }
      console.log(order.join("\n"))
      const body = init?.body
      console.log(`  body   : ${typeof body === "string" ? body.slice(0, 200) : `(${typeof body})`}`)
      console.log()
    }
    return globalThis.fetch(url, init)
  },
})
const auth = { access, uid, accountScope: record?.accountScope }
const getAuth = async () => auth

const loader = await plugin.auth.loader(getAuth, { id: "phanthy" })
console.log("=== loader 返回 ===")
console.log(`  baseURL : ${loader.baseURL}`)
console.log(`  apiKey  : ${loader.apiKey ? `len=${String(loader.apiKey).length}` : "(空)"}`)
console.log(`  headers : ${JSON.stringify(loader.headers)}`)
console.log()

const body = JSON.stringify({
  model: MODEL,
  max_tokens: 32,
  messages: [{ role: "user", content: "只回四个字：链路已通" }],
})

console.log("=== 通过 loader.fetch 发请求 ===")
try {
  const res = await loader.fetch(`${loader.baseURL}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body,
  })
  console.log(`  HTTP ${res.status} ${res.statusText}`)
  const text = await res.text()
  console.log(`  ${text.slice(0, 600)}`)
  if (res.ok) console.log("\n🏁 插件 loader 路径通")
  else console.log("\n✗ 插件 loader 路径 403 —— 与 probe-e2e 的差异要查")
} catch (error) {
  console.log(`  ✗ 抛错: ${error?.name} status=${error?.status} code=${error?.code}`)
  console.log(`    ${String(error?.message).slice(0, 400)}`)
}
