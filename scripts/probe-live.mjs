// scripts/probe-live.mjs —— 真机探针：用本机未过期的云端 access token
// 依次调用 usage / models / checkin（只读状态），逐个打印**脱敏后**的结果。
//
// 用法：node scripts/probe-live.mjs [usage|models|checkin|all]
//
// 边界：
//   · 只读本机 `.phanthy-code/.credentials.json` 的 access token（不碰 refresh / 私钥）
//   · 签到默认就会领取（0.1.0 起没有环境变量闸门）
//   · 任何输出都不含 token 值；只打印长度与 sha8

import { readImportedAccess, summarizeDetection, detectLocalLogin } from "../src/local-import.mjs"
import { fingerprint } from "../src/credential.mjs"

const which = process.argv[2] ?? "all"

function mask(value) {
  const s = String(value ?? "")
  return s ? `len=${s.length} sha8=${fingerprint(s).slice(0, 8)}` : "(empty)"
}

const detection = detectLocalLogin()
const summary = summarizeDetection(detection)
console.log("=== 本机凭据 ===")
for (const line of summary.lines) console.log(" ", line)

let auth
try {
  const imported = readImportedAccess()
  auth = {
    access: imported.access,
    expires: imported.expires,
    // plugin 的 uidOf 需要凭据指纹；accountScope 未知（profile 未调）
    accountScope: undefined,
  }
  console.log(`  导入: ${mask(imported.access)} 剩余 ${imported.remainingSeconds}s`)
} catch (error) {
  console.error("  导入失败:", error.message)
  process.exit(2)
}

const { PhanthyCodeAuthPlugin } = await import("../index.mjs")
const hooks = await PhanthyCodeAuthPlugin({}, {})

async function getAuth() {
  return auth
}

if (which === "all" || which === "usage") {
  console.log("\n=== ① usage（用量面板） ===")
  try {
    const result = await hooks.auth.usage(getAuth, { id: "phanthy" })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error("  抛错:", error?.name, error?.message)
    console.error("  status:", error?.status, "code:", error?.code)
  }
}

if (which === "all" || which === "models") {
  console.log("\n=== ② models（模型目录） ===")
  try {
    const models = await hooks.provider.models({ id: "phanthy" }, { auth })
    const ids = Object.keys(models)
    console.log(`  条数: ${ids.length}`)
    for (const id of ids.slice(0, 40)) {
      const m = models[id]
      console.log(`  - ${id}  name=${m?.name ?? "?"} ctx=${m?.limit?.context ?? "?"} out=${m?.limit?.output ?? "-"}`)
    }
    if (ids.length > 40) console.log(`  ... 还有 ${ids.length - 40} 条`)
  } catch (error) {
    console.error("  抛错:", error?.name, error?.message)
    console.error("  status:", error?.status, "code:", error?.code)
  }
}

if (which === "all" || which === "checkin") {
  console.log("\n=== ③ checkin（每日签到，只读状态） ===")
  try {
    const result = await hooks.auth.checkin(getAuth, { id: "phanthy" })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error("  抛错:", error?.name, error?.message)
    console.error("  status:", error?.status, "code:", error?.code)
  }
}
