#!/usr/bin/env node
// scripts/detect-local-login.mjs —— 只读检查本机有没有可导入的 Phanthy 登录
//
// 只报「文件在不在 / 有哪些字段 / 字段类型 / 分类 / 剩余秒数」，**不打印任何值**。
// 不启动桌面端、不联网、不读无关文件、不碰凭据管理器。
//
// 用法：
//   node scripts/detect-local-login.mjs [--home <用户目录>] [--json]

import { candidateFiles, detectLocalLogin, summarizeDetection } from "../src/local-import.mjs"

function parseArgs(argv) {
  const out = { home: "", json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === "--home") {
      out.home = String(argv[i + 1] ?? "")
      i += 1
    } else if (key === "--json") {
      out.json = true
    } else if (key === "--help" || key === "-h") {
      out.help = true
    } else {
      out.unknown = key
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log("node scripts/detect-local-login.mjs [--home <用户目录>] [--json]\n\n只读检测，只输出存在性、字段类型与剩余秒数，不输出任何值。")
  process.exit(0)
}
if (args.unknown) {
  console.error(`✖ 未知参数：${args.unknown}`)
  process.exit(2)
}

const detection = args.home ? detectLocalLogin({ home: args.home }) : detectLocalLogin()
const summary = summarizeDetection(detection)
const file = args.home ? candidateFiles(args.home)[0] : candidateFiles()[0]

if (args.json) {
  console.log(JSON.stringify({ file, found: detection.found, importable: detection.importable, candidates: detection.candidates }, null, 2))
} else {
  console.log(`\n凭据文件：${file}\n`)
  for (const line of summary.lines) console.log(`  ${line}`)
  console.log(
    `\n结论：${summary.found ? (summary.importable ? "有可导入的、未过期的云端 access token" : "有凭据，但不能导入（见上面理由）") : "本机没有找到官方登录凭据"}`,
  )
  console.log("说明：只导入未过期的云端 access token；refresh_token / 推理令牌 / 设备私钥一律不导入。\n")
}