#!/usr/bin/env node
// 维护检查 —— 查「这个插件还维护得下去吗」，不是「它写对了吗」。
//
//   node scripts/check-maintenance.mjs            # 检查当前目录
//   node scripts/check-maintenance.mjs ../my-plugin
//
// 退出码 0 = 维护状态正常，1 = 有会让用户拿不到更新的问题。
//
// 为什么需要它：插件不是一次性产物。最常见的失配不是代码写错，而是 ——
//   · 改了代码，直接 git push，**不发新版本**（git 源的用户永远停在旧 commit）
//   · 版本号没动，用户那边 magpie 比版本号相等 ⇒ 认为「没有更新」
//   · 发了新版本但没打 tag ⇒ GitHub 上「暂无发布版本」，Release 是空的
//   · 三个版本跳着发，中间两个没 tag ⇒ 用户不知道中间改了什么
// 这些都不报错，只是「用户永远拿不到新版」。这和写完就不管是同一种后果。
//
// 它只依赖 git 与 package.json / CHANGELOG；只有「⑥ 需要全量 tag 列表」时才会走网络。

import { readFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const ROOT = resolve(process.argv[2] ?? ".")
const results = []
const ok = (cond, name, note, fix) => results.push({ level: cond ? "pass" : "fail", name, note, fix })
const warn = (cond, name, note, fix) => results.push({ level: cond ? "pass" : "warn", name, note, fix })

function git(args, { timeout = 30000 } = {}) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", timeout })
  if (r.status !== 0) return null
  return (r.stdout ?? "").trim()
}

// ── 读 package.json ──────────────────────────────────────────────────

let pkg = null
try {
  pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
} catch {
  console.log("\n没有可读的 package.json —— 不是一个 npm 包，维护检查不适用\n")
  process.exit(0)
}
const version = String(pkg.version ?? "")

// ── ① 是不是 git 仓库 ────────────────────────────────────────────────

const isGit = git(["rev-parse", "--is-inside-work-tree"]) === "true"
if (!warn(isGit, "是 git 仓库", "维护依赖版本历史；没有 git 就只能靠文件名记版本", "git init 并把当前状态作为首个 commit")) {
  report()
}

// 浅克隆：`git tag` 只会带回 HEAD 附近的 tag，拿它做全量对账会大面积误报。
// 唯一可靠的修法是 unshallow，或者改问远程要 tag 列表（见 ⑥）。
const isShallow = isGit && existsSync(join(ROOT, ".git", "shallow"))

// ── ② 有没有发布过 ──────────────────────────────────────────────────

const lastTag = git(["describe", "--tags", "--abbrev=0", "--match", "v*"])
const localTags = (git(["tag", "--list", "v*", "--sort=-v:refname"]) ?? "").split("\n").filter(Boolean)

if (!warn(!!lastTag, "至少打过一次 tag", "没有 tag ⇒ GitHub 右侧永远写着「暂无发布版本」，用户看不到改了什么", "git tag v" + version + " && git push origin v" + version)) {
  report()
}

// ── ③ 当前 version 有没有对应的 tag ──────────────────────────────────
// 「发了新版本但没打 tag」是最常见的一种：本地全对，用户拿不到。

const currentTag = `v${version}`
ok(localTags.includes(currentTag),
   `当前版本 ${version} 有 tag（${currentTag}）`,
   "版本号改了但没打 tag ⇒ 用户看 Release 是空的；npm 有、git 源没有",
   `git tag ${currentTag} && git push origin ${currentTag}`)

// ── ④ 自上次 tag 以来，代码变了但版本没变 ────────────────────────────
// 这就是「直接覆盖仓库不发新版本」：git 源的用户永远停在旧 commit，
// 而作者以为「我 push 了，大家应该拿到了」。

const CODE = /\.(mjs|js|cjs|ts|tsx|json)$/
const changedSince = (() => {
  const committed = (git(["diff", "--name-only", `${lastTag}..HEAD`]) ?? "").split("\n").filter(Boolean)
  const dirty = (git(["status", "--porcelain"]) ?? "")
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
  return [...new Set([...committed, ...dirty])].filter((f) => CODE.test(f) && !f.startsWith("package-lock"))
})()

const versionBumped = `v${version}` !== lastTag
if (changedSince.length > 0) {
  ok(versionBumped,
     "自上次 tag 以来改了代码 ⇒ 版本号也跟着变了",
     `改了 ${changedSince.length} 个代码文件但 version 还是 ${lastTag?.slice(1)} —— ` +
     `magpie 比的是版本号，相等就认为「没有更新」，git 源的用户永远停在旧 commit`,
     `改完就 bump：npm version patch --no-git-tag-version（然后按 UPDATING 七步走）`)
} else {
  warn(true, "自上次 tag 以来没有代码改动", "要么还没开始改，要么已经发布过了", "")
}

// ── ⑤ CHANGELOG 有没有当前版本这一节 ─────────────────────────────────

const changelog = existsSync(join(ROOT, "CHANGELOG.md")) ? readFileSync(join(ROOT, "CHANGELOG.md"), "utf8") : ""
ok(changelog.includes(version),
   `CHANGELOG 有 ${version} 这一节`,
   "没有更新日志 ⇒ 用户不知道升上去改了什么，出问题也没法回滚到「哪个版本是好的」",
   `在 CHANGELOG.md 顶部加「## ${version} — <日期>」一节`)

// ── ⑥ CHANGELOG 与 tag 双向对账 ──────────────────────────────────────
// 旧版写的是「查 from → to 之间有没有跳版」，判据本身是错的：
//   lastTag 取的是「最近的 tag」，刚发完版时 from === to，整段空跑，
//   于是一律报「✓ 没有跳过版本」—— 历史里有多少个版本没打 tag 都看不见。
//
// 换成更根本的判据：CHANGELOG 里列出的每个版本都该有 tag（否则用户拿不到），
// 每个 tag 也都该有 CHANGELOG 节（否则 release.yml 抽不到正文、会建空 Release）。

function parseSemver(s) {
  const m = String(s).match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
const verKey = (s) => parseSemver(s)?.[0] * 1e6 + parseSemver(s)?.[1] * 1e3 + parseSemver(s)?.[2]

/** 全量 tag：优先问远程（浅克隆也能拿全），失败退回本地 */
function allTags() {
  const remote = git(["ls-remote", "--tags", "origin"], { timeout: 30000 })
  if (remote) {
    const set = new Set()
    for (const line of remote.split("\n")) {
      const m = line.match(/refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/)
      if (m) set.add(m[1])
    }
    if (set.size > 0) return { tags: [...set], source: "远程 origin" }
  }
  return { tags: localTags, source: isShallow ? "本地（浅克隆，可能不全）" : "本地" }
}

/** CHANGELOG 里出现过的版本（`## 0.3.9 — 2026-11-04`） */
function changelogVersions() {
  const out = []
  const re = /^##\s+v?(\d+\.\d+\.\d+)/gm
  let m
  while ((m = re.exec(changelog))) out.push(m[1])
  return out
}

if (changelog) {
  const { tags: all, source } = allTags()
  const tagSet = new Set(all.map((t) => t.replace(/^v/, "")))
  const clSet = new Set(changelogVersions())

  const noTag = [...clSet].filter((v) => !tagSet.has(v)).sort((a, b) => verKey(b) - verKey(a))
  const noSection = [...tagSet].filter((v) => !clSet.has(v)).sort((a, b) => verKey(b) - verKey(a))

  // 当前版本是 fail（这次发布就不完整），历史欠账是 warn（列出来，但不堵门）
  const nowMissing = noTag.includes(version)
  warn(!nowMissing,
       `当前版本 ${version} 在 CHANGELOG 与 tag 之间对得上`,
       `CHANGELOG 写了 ${version} 但 tag 列表里没有 —— 用户看 Release 是空的`,
       `git tag v${version} && git push origin v${version}`)

  const historicNoTag = noTag.filter((v) => v !== version)
  warn(historicNoTag.length === 0,
       `历史版本都打过 tag（共 ${all.length} 个 tag / ${clSet.size} 节 CHANGELOG）`,
       `${historicNoTag.length} 个版本有 CHANGELOG 节但没有 tag：${historicNoTag.join(" / ")}\n` +
       `  （tag 来源：${source}${isShallow && source.includes("本地") ? " —— 浅克隆看不到全部 tag，先 git fetch --unshallow 再判断" : ""}）\n` +
       `  用户拿不到这些版本，也说不清自己在哪版上出的问题`,
       "补历史 tag：git tag v<版本> <commit> && git push origin --tags（补 tag 不改代码、不需要重发）")

  warn(noSection.length === 0,
       "每个 tag 都有 CHANGELOG 节",
       `${noSection.length} 个 tag 在 CHANGELOG 里找不到对应章节：${noSection.join(" / ")}\n` +
       `  release.yml 用 awk 从 CHANGELOG 抽 Release 正文，抽不到会直接 exit 1`,
       "补章节，或在 UPDATING.md 里写明这些版本是「无正文的补发 tag」")
}

// ── 输出 ──────────────────────────────────────────────────────────────

report()

function report() {
  const fails = results.filter((r) => r.level === "fail")
  const warns = results.filter((r) => r.level === "warn")
  const mark = { pass: "\x1b[32m✓\x1b[0m", fail: "\x1b[31m✗\x1b[0m", warn: "\x1b[33m!\x1b[0m" }
  console.log(`\n维护检查 · ${ROOT}\n`)
  for (const r of results) {
    console.log(`  ${mark[r.level]} ${r.name}`)
    if (r.level !== "pass" && r.note) console.log(`      ${r.note}`)
    if (r.level !== "pass" && r.fix && r.fix.length > 0) console.log(`      → ${r.fix}`)
  }
  console.log(`\n  通过 ${results.filter((r) => r.level === "pass").length} · 警告 ${warns.length} · 失败 ${fails.length}\n`)
  if (fails.length) {
    console.log("  这些问题的后果是同一个：**用户永远拿不到新版**。而本地一切看起来都对。\n")
  }
  process.exit(fails.length ? 1 : 0)
}