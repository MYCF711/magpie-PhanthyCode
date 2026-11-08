// scripts/probe-max-output.mjs —— 上游到底允许多大 max_tokens
//
// 只发一个 `max_tokens` 超大的请求，看它是 200 还是 400/413。
// 400 的话错误信息里通常直接写了上限，比一点点试快得多。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"

import { PhanthyCodeAuthPlugin } from "../index.mjs"

const store = JSON.parse(readFileSync(homedir() + "/.config/magpie/plugin-auth.json", "utf8"))
const auth = store.phanthycode ?? {}
const plugin = await PhanthyCodeAuthPlugin({}, { fetch: globalThis.fetch })
const loader = await plugin.auth.loader(async () => auth, { id: "phanthycode" })

const model = process.argv[2] ?? "deepseek-v4.1-flash-1017"

for (const maxTokens of [64_000, 200_000, 1_000_000]) {
  const t0 = Date.now()
  const res = await loader.fetch(loader.baseURL + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: "只回一个字：好" }],
    }),
  })
  const text = await res.text()
  const ms = Date.now() - t0
  let note = text.slice(0, 200).replace(/\s+/g, " ")
  try {
    const j = JSON.parse(text)
    if (j.type === "message") note = `ok · out=${j.usage?.output_tokens}`
    else note = JSON.stringify(j.error ?? j).slice(0, 200)
  } catch {}
  console.log(`  max_tokens=${String(maxTokens).padStart(9)}  HTTP ${res.status}  ${ms}ms  ${note}`)
  if (res.status >= 400) break
}
