#!/usr/bin/env node
// check-actions.mjs —— 本仓库 workflow 里引用的 GitHub Action 有没有落后
//
//   node scripts/check-actions.mjs              # 联网比对（要 curl + 网络）
//   node scripts/check-actions.mjs --offline    # 只列清单，不查最新版
//   node scripts/check-actions.mjs --json       # 机器可读
//
// 退出码：0 = 都不落后（或浮动引用已被接受）
//         2 = 有落后（或者有写死完整版本号但 upstream 已经前进）
//         1 = 查不到（网络 / 限流 / curl 不可用）—— 这是「没法判断」，不是「落后」
//
// 为什么是脚本而不是 dependabot：这个仓库的分发形态是「协议 + 派生仓库」。
// 派生仓库带走的是 AGENTS.md，不是 GitHub 上的一个定时器 —— 定时器只作用于
// 本仓库，管不到派生出来的那几十个插件仓库。所以「版本该不该升」这件事
// 必须写在协议里、能一条命令验出来，而不是挂在某个仓库的设置里。
//
// 什么时候跑：发版前一分钟。它不需要进 CI（CI 上跑会被 API 限流，而且
// 上游发新版不该让别人的 PR 变红）。

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { execFileSync } from "node:child_process"

// 位置参数是目录；`--offline` 之类的开关不能被当成路径（否则 resolve("--offline") 是个不存在的地方）
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const ROOT = resolve(positional[0] ?? ".")
const OFFLINE = process.argv.includes("--offline")
const AS_JSON = process.argv.includes("--json")

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

// ── 1. 找出所有 workflow / 复合 action 文件 ──────────────────────────

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.ya?ml$/.test(name)) out.push(p)
  }
  return out
}

const files = [
  ...walk(join(ROOT, ".github", "workflows")),
  ...walk(join(ROOT, ".github", "actions")),
]
if (files.length === 0) {
  console.error(C.red("✗ 没有找到 .github/workflows 或 .github/actions"))
  process.exit(1)
}

// ── 2. 抽 uses: ──────────────────────────────────────────────────────

/** @type {{repo:string, ref:string, where:string}[]} */
const refs = []
for (const f of files) {
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, "/")
  const lines = readFileSync(f, "utf8").replace(/\r\n/g, "\n").split("\n")
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:-\s*)?uses:\s*['"]?([^'"\s#]+)['"]?/)
    if (!m) return
    const spec = m[1]
    if (spec.startsWith("./") || spec.startsWith("docker://")) return // 本地路径 / 镜像，不查
    const at = spec.lastIndexOf("@")
    if (at < 0) return
    const path = spec.slice(0, at)
    const ref = spec.slice(at + 1)
    // owner/repo[/sub/path] → owner/repo
    const [owner, repo] = path.split("/")
    if (!owner || !repo) return
    refs.push({ repo: `${owner}/${repo}`, ref, where: `${rel}:${i + 1}` })
  })
}

if (refs.length === 0) {
  console.log(C.dim("没有找到任何 uses: 引用"))
  process.exit(0)
}

// 同一个 action 可能被多个文件引用，按 ref 分组
/** @type {Map<string, {ref:string, where:string[]}[]>} */
const byRepo = new Map()
for (const r of refs) {
  if (!byRepo.has(r.repo)) byRepo.set(r.repo, [])
  const list = byRepo.get(r.repo)
  const hit = list.find((x) => x.ref === r.ref)
  if (hit) hit.where.push(r.where)
  else list.push({ ref: r.ref, where: [r.where] })
}

// ── 3. 查最新版 ──────────────────────────────────────────────────────

function latestTag(repo) {
  const headers = ["-H", "Accept: application/vnd.github+json", "-H", "User-Agent: check-actions"]
  // 有 GITHUB_TOKEN 就用，避免 60 次/小时的匿名限流
  const tok = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (tok) headers.push("-H", `Authorization: Bearer ${tok}`)

  const curlJson = (u) => JSON.parse(execFileSync("curl", ["-sS", "--max-time", "20", ...headers, u], { encoding: "utf8" }))
  const isSemverTag = (n) => /^v\d+(\.\d+)*$/.test(n)

  // ① 优先 releases/latest —— 大多数 action 走这条
  try {
    const j = curlJson(`https://api.github.com/repos/${repo}/releases/latest`)
    if (j.tag_name && isSemverTag(j.tag_name)) return j.tag_name
  } catch {}

  // ② 有些 action 的 Release tag 不是 semver（比如 github/codeql-action 用
  //    `codeql-bundle-v2.27.4`），但它们的 tags 里有 `v3` / `v3.30.x` 这类可用于
  //    `uses:` 的 tag —— 从 tags 里挑 semver 形态的最大值。
  try {
    const arr = curlJson(`https://api.github.com/repos/${repo}/tags?per_page=100`)
    if (Array.isArray(arr) && arr.length) {
      const sem = arr.map((t) => t.name).filter(isSemverTag)
      sem.sort((a, b) => {
        const pa = a.slice(1).split(".").map(Number)
        const pb = b.slice(1).split(".").map(Number)
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
        }
        return 0
      })
      if (sem[0]) return sem[0]
    }
  } catch {}

  return null
}

const parseVer = (s) => {
  const m = String(s).replace(/^v/, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
  return m ? [Number(m[1]), m[2] === undefined ? null : Number(m[2]), m[3] === undefined ? null : Number(m[3])] : null
}

// ── 4. 判定 ──────────────────────────────────────────────────────────

const rows = []
for (const [repo, list] of [...byRepo.entries()].sort()) {
  const latest = OFFLINE ? null : latestTag(repo)
  for (const { ref, where } of list) {
    const cur = parseVer(ref)
    let status
    if (!cur) status = "float"        // main / master / v1-beta 之类，非 semver
    else if (latest === null) status = OFFLINE ? "skip" : "unknown"
    else {
      const lat = parseVer(latest)
      if (!lat) status = "unknown"
      else if (cur.length === 0) status = "unknown"
      // 只写 major（v7）时，只要 major 对得上就算 ok —— floating major tag 是官方推荐写法
      else if (cur[1] === null) status = cur[0] === lat[0] ? "ok" : "behind"
      else if (cur[2] === null) status = cur[0] === lat[0] && cur[1] === lat[1] ? "ok" : "behind"
      else {
        const same = cur[0] === lat[0] && cur[1] === lat[1] && cur[2] === lat[2]
        status = same ? "ok" : "behind"
      }
    }
    rows.push({ repo, ref, latest, status, where })
  }
}

if (AS_JSON) {
  console.log(JSON.stringify(rows, null, 2))
  process.exit(rows.some((r) => r.status === "behind") ? 2 : 0)
}

// ── 5. 输出 ──────────────────────────────────────────────────────────

const W = Math.max(...rows.map((r) => r.repo.length), 12)
console.log()
console.log(`${"action".padEnd(W)}  ${"当前".padEnd(10)} ${"最新".padEnd(12)} 状态`)
console.log("-".repeat(W + 40))
for (const r of rows) {
  const mark = { ok: C.green("ok"), behind: C.red("落后"), float: C.yellow("浮动引用"), unknown: C.dim("查不到"), skip: C.dim("未查") }[r.status]
  console.log(`${r.repo.padEnd(W)}  ${r.ref.padEnd(10)} ${(r.latest ?? "-").padEnd(12)} ${mark}`)
}

const behind = rows.filter((r) => r.status === "behind")
const floats = rows.filter((r) => r.status === "float")
const unknown = rows.filter((r) => r.status === "unknown")

if (floats.length) {
  console.log(C.yellow(`\n! ${floats.length} 处引用不是 semver（main / master / 某个分支）—— 行为不可复现，建议换成 major tag（@v7）`))
  for (const f of floats) console.log(C.dim(`    ${f.where}  ${f.repo}@${f.ref}`))
}

if (unknown.length) {
  console.log(C.dim(`\n   ${unknown.length} 个查不到最新版（网络或限流）。不是「没问题」，是「没判断」。`))
  console.log(C.dim(`   跑一遍：GITHUB_TOKEN=$(gh auth token) node scripts/check-actions.mjs`))
}

console.log()
if (behind.length) {
  console.log(C.red(`${behind.length} 个 action 落后：`))
  for (const b of behind) {
    console.log(C.red(`  ${b.repo}  ${b.ref} → ${b.latest}`))
    for (const w of b.where) console.log(C.dim(`      ${w}`))
  }
  console.log(C.dim("\n升版本时注意：major 升级要看上游的 breaking changes；升完跑一次完整 CI。"))
  console.log(C.dim("本仓库的 release workflow 只在推 tag 时触发，PR 上测不到它 —— 发版前手工 dispatch 一次更稳。"))
  process.exit(2)
}

console.log(C.green("所有 action 都在最新 major 上"))
if (OFFLINE) console.log(C.dim("（--offline：只列清单，没查最新版）"))
console.log()
