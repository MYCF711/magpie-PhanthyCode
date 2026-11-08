// scripts/verify-endpoint.mjs —— 确认请求真的打到了 PhanthyCode，而不是别处
//
// 抓：实际 URL、发出去的请求头、响应头、响应体里的 model / id / usage。
// 有些人会怀疑「是不是被路由到别的 provider 了」—— 这份输出就是答案。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"

import { PhanthyCodeAuthPlugin } from "../index.mjs"

const store = JSON.parse(readFileSync(homedir() + "/.config/magpie/plugin-auth.json", "utf8"))
const auth = store.phanthycode ?? {}
if (!String(auth.access || auth.key || "").trim()) {
  console.error("✖ magpie 里没有 phanthycode 登录态")
  process.exit(2)
}

/** 包一层 fetch：把真实出站请求原样打出来 */
const seen = []
const spyFetch = async (url, init = {}) => {
  const headers = {}
  const h = init.headers ?? {}
  if (typeof h.forEach === "function" && !Array.isArray(h)) {
    h.forEach((v, k) => (headers[k] = v))
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) headers[k] = v
  } else {
    Object.assign(headers, h)
  }
  seen.push({ url: String(url), method: init.method ?? "GET", headers: { ...headers } })
  return globalThis.fetch(url, init)
}

const plugin = await PhanthyCodeAuthPlugin({}, { fetch: spyFetch })
const loader = await plugin.auth.loader(async () => auth, { id: "phanthycode" })

console.log("======== ① 插件给出的 baseURL / apiKey ========")
console.log(`  baseURL : ${loader.baseURL}`)
console.log(`  apiKey  : len=${String(loader.apiKey ?? "").length}`)
console.log("")

console.log("======== ② 发一次请求 ========")
const res = await loader.fetch(loader.baseURL + "/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model: "deepseek-v4.1-flash-1017",
    max_tokens: 16,
    messages: [{ role: "user", content: "回两个字：收到" }],
  }),
})

console.log(`  HTTP ${res.status}`)
console.log("")

console.log("======== ③ 响应头（看是谁回的）========")
for (const key of ["server", "date", "content-type", "x-request-id", "cf-ray", "via", "x-served-by", "x-backend"]) {
  const v = res.headers.get(key)
  if (v) console.log(`  ${key.padEnd(14)}: ${v}`)
}
console.log("")

const body = await res.text()
let parsed = null
try {
  parsed = JSON.parse(body)
} catch {}
console.log("======== ④ 响应体 ========")
if (parsed) {
  console.log(`  id      : ${parsed.id}`)
  console.log(`  model   : ${parsed.model}`)
  console.log(`  type    : ${parsed.type}`)
  console.log(`  usage   : in=${parsed.usage?.input_tokens} out=${parsed.usage?.output_tokens}`)
} else {
  console.log(`  ${body.slice(0, 300)}`)
}
console.log("")

console.log("======== ⑤ 插件实际发出的请求 ========")
for (const call of seen) {
  const u = new URL(call.url)
  console.log(`  ${call.method} ${u.origin}${u.pathname}`)
  const names = Object.keys(call.headers).sort()
  console.log(`    头: ${names.join(", ")}`)
  for (const k of ["host", "authorization", "x-phanthy-desktop-session", "x-desktop-installation-id", "x-request-id", "user-agent"]) {
    if (call.headers[k] !== undefined) {
      const v = call.headers[k]
      const shown = /authorization|session/i.test(k) ? `len=${v.length}` : String(v).slice(0, 60)
      console.log(`      ${k}: ${shown}`)
    }
  }
}
console.log("")
console.log(`  共 ${seen.length} 次出站请求`)
