#!/usr/bin/env node
// 装本地 git 钩子：pre-commit（提交前脱敏）+ pre-push（推送前分级门禁）。
//
// 为什么要有这个：CI 的五步（check / test / docs / privacy / pack）过去只靠人自觉跑。
// 漏一次就是「推上去才发现红」，红一次就是一封邮件 + 一轮返工。而本仓库实测：
//   check.mjs 约 0s、privacy-scan 约 0s、node --test 326 条约 2s、npm pack 约 1s
// —— 整套在本地跑完不到 5 秒，没有任何理由留到 CI 才发现。
//
// 两个钩子的分工：
//   pre-commit  privacy-scan --staged   只扫本次暂存的文件。毫秒级，防的是「秘密进了历史」。
//   pre-push    快档（每次推送）        check + privacy
//               全档（只在合入点）      + npm test + check-docs + npm pack --dry-run
//               合入点 = 推 main / 首次推一个新分支（git push -u）/ PLUGIN_FULL=1
//
// 用法：node scripts/install-hooks.mjs
// 卸载：rm .git/hooks/pre-commit .git/hooks/pre-push

import { copyFileSync, existsSync, chmodSync, mkdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(HERE, "hooks")

function gitRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
  } catch {
    return null
  }
}

const root = gitRoot()
if (!root) {
  console.error("install-hooks: 当前目录不是 git 仓库。先 git init，再跑一次。")
  process.exit(2)
}

const hooksDir = join(root, ".git", "hooks")
mkdirSync(hooksDir, { recursive: true })

const wanted = ["pre-commit", "pre-push"]
for (const name of wanted) {
  const src = join(TEMPLATE, name)
  if (!existsSync(src)) {
    console.error(`install-hooks: 模板缺失 ${src}`)
    process.exit(2)
  }
  const dst = join(hooksDir, name)
  const existed = existsSync(dst)
  copyFileSync(src, dst)
  try {
    chmodSync(dst, 0o755)
  } catch {
    // Windows 上 chmod 基本无效，git 也不靠它判断可执行 —— 忽略。
  }
  console.log(`${existed ? "已覆盖" : "已安装"}  .git/hooks/${name}`)
}

console.log("")
console.log("两个钩子已就位：")
console.log("  pre-commit  每次提交前扫暂存区（毫秒级）")
console.log("  pre-push    每次推送前跑快档；推 main / 首次推新分支时跑全档（约 3~5 秒）")
console.log("")
console.log("逃生门（只跳过这一次，不是永久关闭）：")
console.log("  PLUGIN_SKIP_HOOK=1 git push")
console.log("要连单测一起跑：")
console.log("  PLUGIN_FULL=1 git push")
