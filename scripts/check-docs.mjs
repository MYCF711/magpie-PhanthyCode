#!/usr/bin/env node
// check-docs.mjs —— 文档时新性门禁
//
// 为什么需要：本仓库 6020 行文档里的数字、版本号、交叉引用全靠手写。
// 手写的东西必然过期，而过期的说明书比没有说明书更坏 —— 读者信它。
//
// 这份脚本只查四件「能机器判真」的事。查不了的（比如「这句话还对不对」）一律不查：
// 宁可少查，也不要因为误报让人把门禁关掉。误报一次，这个脚本就死了。
//
// 用法：
//   node scripts/check-docs.mjs            # 检查，有 fail 则 exit 1
//   node scripts/check-docs.mjs --verbose  # 打印每条通过的检查
//
// 退出码：0 = 全过（warn 不算失败）
//         1 = 有 fail
//         2 = 脚本自身环境不对（不是 git 仓库 / 没有 package.json）

import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, dirname, resolve, relative, sep } from "node:path"

const ROOT = process.cwd()
const VERBOSE = process.argv.includes("--verbose")

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

// ---- 断言累积（与 check.mjs 同一套语义，便于两个脚本一起读） ----
let pass = 0
const fails = []
const warns = []
const ok = (msg) => { pass++; if (VERBOSE) console.log(C.green(`✓ ${msg}`)) }
const fail = (msg, detail) => { fails.push(detail ? `${msg}\n${indent(detail)}` : msg) }
const warn = (msg, detail) => { warns.push(detail ? `${msg}\n${indent(detail)}` : msg) }
const indent = (s) => String(s).split("\n").map((l) => "    " + l).join("\n")

// ---- 环境 ----
const pkgPath = join(ROOT, "package.json")
if (!existsSync(pkgPath)) {
  console.error(C.red("✗ 没有 package.json —— 请在仓库根目录跑"))
  process.exit(2)
}
const PKG = JSON.parse(readFileSync(pkgPath, "utf8"))
const VERSION = String(PKG.version || "")
if (!VERSION) {
  console.error(C.red("✗ package.json 没有 version"))
  process.exit(2)
}

// 被跟踪的文本文件（走 git，避免扫到 node_modules / 临时文件）
function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: ROOT })
      .split("\n").map((s) => s.trim()).filter(Boolean)
  } catch {
    console.error(C.red("✗ 不是 git 仓库（或 git 不可用）—— 本脚本靠 git ls-files 定位文件"))
    process.exit(2)
  }
}

// `git ls-files` 会包含「已经从工作区删掉但还没 git rm」的文件 —— 那些读不到，直接排除。
// 不排除的话，删一个文件、还没提交就跑去检查，脚本会 ENOENT 崩掉（而不是报出真实的文档问题）。
const FILES = trackedFiles().filter((f) => existsSync(join(ROOT, f)))
const isText = (f) => /\.(md|mjs|js|json|yml|yaml|py|sh)$/.test(f)
const read = (f) => readFileSync(join(ROOT, f), "utf8").replace(/\r\n/g, "\n")

// 跳过这些 —— 它们是历史记录 / 测试夹具，本来就会出现过期版本号
const SKIP_VERSION_CHECK = [
  "CHANGELOG.md",
  "MAINTENANCE.md",       // 台账允许写「上一版发布时的状态」，由检查二单独管
  "node_modules/",
  "tests/",
  "tmp/",
]

// ============================================================
// 检查一 · 文档里指向本仓库的版本号是否等于当前 version
// ============================================================
// 判据：**文件里提到本仓库**（含 `magpie-plugin-scaffold`）时，它出现的每个
// `#vX.Y.Z` / `@vX.Y.Z` 都必须等于当前版本。别处的版本号（`actions/checkout@v4` 之类）不碰。
//
// `--sync` 直接改：把命中的旧版本号替换成当前版本，然后退出 0。
// 用法上它属于「发版流程的一步」，不是门禁 —— 门禁跑不带参数的那次。
const SYNC = process.argv.includes("--sync")

;(() => {
  // 只认两种**紧贴着仓库名**的形态，别的一律不碰：
  //   A. `magpie-plugin-scaffold#vX.Y.Z` / `magpie-plugin-scaffold@vX.Y.Z`
  //   B. `magpie-plugin-scaffold/.github/actions/check@vX.Y.Z`（uses: 里的 action 引用）
  //
  // 示例里故意写 `vX.Y.Z` 而不是某个具体版本：写具体版本的话，这段注释自己就会被
  // 本检查判成「过期版本号」，每次发版都要连脚本一起改 —— 那正好是它在抓的病。
  //
  // 早先版本用「文件里提到仓库名 ⇒ 全文都查」做门，结果把自己写的
  //   `ossf/scorecard-action@v2.4.0`
  // 误判成「文档版本号过期」，PR 第一次跑就红了。这种文件级的粗判据不能用：
  // 一个 workflow 里只要出现一次仓库名，整个文件里的所有版本号都会被牵连。
  const PATTERNS = [
    /magpie-plugin-scaffold([#@])v(\d+\.\d+\.\d+)/g,
    /magpie-plugin-scaffold\/[^\s@]*@v(\d+\.\d+\.\d+)/g,
  ]
  const bad = []
  const synced = []

  for (const f of FILES.filter(isText)) {
    if (SKIP_VERSION_CHECK.some((s) => f === s || f.startsWith(s))) continue
    const text = read(f)
    const hits = []
    for (const re of PATTERNS) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(text))) {
        if (m[m.length - 1] === VERSION) continue
        const line = text.slice(0, m.index).split("\n").length
        hits.push({ line, raw: m[0], from: m[m.length - 1] })
      }
    }
    if (hits.length === 0) continue

    if (SYNC) {
      let replaced = text
      for (const re of PATTERNS) {
        re.lastIndex = 0
        // 两个模式都以 `vX.Y.Z` 结尾，只对齐末尾那一截就行。
        // 别把回调参数当「捕获组数组」用：replace 的回调在捕获组之后还追加
        // (offset, string)，于是 `g[g.length - 1]` 拿到的是**整篇原文**而不是版本号 ——
        // 早先这么写的时候，--sync 每次都替换不了任何东西，却照样报「已经是当前版本」。
        replaced = replaced.replace(re, (all) =>
          all.endsWith(`v${VERSION}`) ? all : all.replace(/v\d+\.\d+\.\d+$/, `v${VERSION}`),
        )
      }
      if (replaced !== text) {
        writeFileSync(join(ROOT, f), replaced)
        synced.push(...hits.map((h) => `${f}:${h.line}  ${h.raw} → 已对齐 ${VERSION}`))
      }
    } else {
      bad.push(...hits.map((h) => `${f}:${h.line}  ${h.raw}  ≠  ${VERSION}`))
    }
  }

  if (SYNC) {
    if (synced.length === 0) ok(`文档里的版本号已经是当前版本（${VERSION}）`)
    else {
      console.log(C.yellow(`已同步 ${synced.length} 处版本号 → ${VERSION}`))
      for (const s of synced) console.log(C.dim(`  ${s}`))
      console.log(C.dim("  记得把这些改动一起提交（它们属于本次发版）。"))
    }
    return
  }

  if (bad.length === 0) ok(`文档里的自身版本号与 package.json 一致（${VERSION}）`)
  else fail(`文档里有 ${bad.length} 处版本号不是当前版本（${VERSION}）—— 读者会把旧版当新版\n跑 \`node scripts/check-docs.mjs --sync\` 一键对齐`, bad.join("\n"))
})()

// ============================================================
// 检查二 · MAINTENANCE.md 台账里的数字是否等于实测
// ============================================================
// 台账是「给接手者看现状」的，它过期等于交接材料在说谎。
// 只查四种能直接数出来的：src 模块数 / src 行数 / tests 文件数 / tests 用例数。
;(() => {
  const M = join(ROOT, "MAINTENANCE.md")
  if (!existsSync(M)) { warn("没有 MAINTENANCE.md，跳过台账数字核对"); return }
  const text = readFileSync(M, "utf8").replace(/\r\n/g, "\n")

  // 行数用 wc -l 的语义（末尾换行不算多一行），否则每个文件凭空多 1 行
  const countLines = (p) => {
    const s = readFileSync(p, "utf8")
    if (s === "") return 0
    return s.replace(/\n$/, "").split("\n").length
  }
  const countSrc = () => {
    const d = join(ROOT, "src")
    if (!existsSync(d)) return { files: 0, lines: 0 }
    const fs = readdirSync(d).filter((f) => f.endsWith(".mjs"))
    return { files: fs.length, lines: fs.reduce((n, f) => n + countLines(join(d, f)), 0) }
  }
  const countTests = () => {
    const d = join(ROOT, "tests")
    if (!existsSync(d)) return { files: 0 }
    return { files: readdirSync(d).filter((f) => f.endsWith(".test.mjs")).length }
  }

  const src = countSrc()
  const tst = countTests()
  const num = (s) => Number(String(s).replace(/[,_\s]/g, ""))

  // 故意只查「能精确数出来的」两样：模块数、测试文件数。
  // 行数与用例数**不查** —— 用例数靠 `node --test` 才知道（循环批量注册的数不到，
  // 正则数出来会比真实值少 20 条），行数依赖编辑器是否补末尾换行。
  // 数不准的指标宁可放进人工 CHECKLIST，也不要让它在这里误报 —— 误报一次，门禁就会被关掉。
  const checks = [
    // `| `src/` 模块 | 27 个 / 5,171 行 |`
    { label: "src 模块数", re: /\|\s*`?src\/`?\s*模块\s*\|\s*([\d,]+)\s*个/, actual: src.files },
    // `| `tests/` | 26 个 / 301 条 |`
    { label: "tests 文件数", re: /\|\s*`?tests\/`?\s*\|\s*([\d,]+)\s*个/, actual: tst.files },
  ]

  const drift = []
  for (const c of checks) {
    const m = text.match(c.re)
    if (!m) continue // 格式变了就不查，交给 warn 之外的人读
    const claimed = num(m[1])
    if (claimed !== c.actual) drift.push(`${c.label}: 写 ${claimed} / 实际 ${c.actual}`)
  }
  if (drift.length === 0) ok("MAINTENANCE.md 的规模数字与实测一致")
  else fail(`MAINTENANCE.md 台账过期 —— 接手的人会按旧数字判断现状`, drift.join("\n"))
})()

// ============================================================
// 检查三 · 标题里写的「N 条」是否等于紧随其后的表格行数
// ============================================================
// 「## 二、十三条会静默出错的坑」下面挂了 35 行表格 —— 这类标题最容易被读者当成总数。
;(() => {
  const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const parseCn = (s) => {
    if (/^\d+$/.test(s)) return Number(s)
    // 十三 / 二十三 / 三十五 …
    if (s.length === 1) return CN[s] ?? NaN
    if (s.startsWith("十")) return 10 + (CN[s[1]] ?? 0)
    if (s.includes("十")) {
      const [a, b] = s.split("十")
      return (CN[a] ?? NaN) * 10 + (b ? (CN[b] ?? 0) : 0)
    }
    return NaN
  }

  const bad = []
  for (const f of FILES.filter((x) => x.endsWith(".md"))) {
    const lines = read(f).split("\n")
    for (let i = 0; i < lines.length; i++) {
      // 只认「N 条」后面紧跟 的/会/在/，/、/。/（/空白/行尾 的情况，
      // 并且 N >= 2 —— 否则「一条错误必须同时说清三件事」这种小标题会被误判成「1 条」。
      const head = lines[i].match(/^#{1,4}\s+.*?([0-9]+|[零一二两三四五六七八九十]+)\s*条(?=$|[的会在，、。：；（）()\s])/)
      if (!head) continue
      const claimed = parseCn(head[1])
      if (!Number.isFinite(claimed) || claimed < 2) continue
      // 从下一行开始数连续属于同一表格的数据行（| 开头且不是分隔行 / 表头）
      let rows = 0
      let seenHeader = false
      for (let j = i + 1; j < lines.length && j < i + 200; j++) {
        const l = lines[j]
        if (/^\s*$/.test(l)) { if (rows > 0) break; else continue }
        if (/^#{1,4}\s/.test(l)) break
        if (!/^\s*\|/.test(l)) { if (rows > 0) break; else continue }
        if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) { seenHeader = true; continue } // |---|---|
        if (!seenHeader) continue // 表头行
        rows++
      }
      if (rows > 0 && rows !== claimed) {
        bad.push(`${f}:${i + 1}  标题写「${claimed} 条」，表内 ${rows} 行`)
      }
    }
  }
  if (bad.length === 0) ok("标题里的「N 条」与表内行数一致")
  else fail(`标题的条数与表格不符 —— 这是读者最容易被误导的地方`, bad.join("\n"))
})()

// ============================================================
// 检查四 · 文档里的相对链接是否指向真实存在的文件
// ============================================================
// 「技术细节见 docs/internals.md」而 docs/ 根本不存在 —— 这类断链最伤信任。
;(() => {
  const dead = []
  // 先取出括号里的完整目标，再自己判断是不是相对文件链接 ——
  // 不用一条正则把前缀和扩展名都吃掉（那样 `../../x.md` 会被截成 `./x.md`）。
  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g
  const FILE_EXT = /\.(?:md|mjs|js|json|yml|yaml|py|sh)$/i

  for (const f of FILES.filter((x) => x.endsWith(".md"))) {
    const text = read(f)
    const baseDir = dirname(join(ROOT, f))
    linkRe.lastIndex = 0
    let m
    while ((m = linkRe.exec(text))) {
      const target = m[1].split("#")[0].split("?")[0]
      if (!target || /^[a-z]+:/i.test(target)) continue // http: mailto: 等
      if (target.startsWith("/")) continue             // 仓库绝对路径写法，语义含糊，不查
      if (!FILE_EXT.test(target)) continue
      const abs = resolve(baseDir, target)
      if (!abs.startsWith(ROOT)) continue // 跳出仓库的不查（可能是开发机的相对路径）
      if (existsSync(abs)) continue
      const line = text.slice(0, m.index).split("\n").length
      dead.push(`${f}:${line}  → ${m[1]}`)
    }
  }
  if (dead.length === 0) ok("文档里的相对链接都指向存在的文件")
  else fail(`有 ${dead.length} 条相对链接指向不存在的文件`, dead.join("\n"))
})()

// ---- 汇总 ----
console.log()
if (VERBOSE) console.log(C.dim(`—— ${FILES.length} 个被跟踪文件，版本 ${VERSION} ——`))
console.log(`${C.bold("通过")} ${pass} · ${C.yellow(`警告 ${warns.length}`)} · ${C.red(`失败 ${fails.length}`)}`)
for (const w of warns) console.log(C.yellow(`\n⚠ ${w}`))
for (const f of fails) console.log(C.red(`\n✗ ${f}`))
if (fails.length > 0) {
  console.log(C.dim("\n修法：这些行都是「写死了会变的东西」。能算的就别写死（改成命令或链接），"))
  console.log(C.dim("      必须写死的就让它随发版一起改 —— scripts/release.mjs 里加一步即可。"))
  process.exit(1)
}
console.log(C.green("\n文档时新性检查全过"))
