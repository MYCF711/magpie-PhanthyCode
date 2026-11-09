// tests/check-version.test.mjs —— `scripts/check.mjs` 的门 ⑧「CHANGELOG 有当前版本」回归
//
// 背景（本仓真实发生过的一次假绿）：0.1.1 发版时 CHANGELOG 还没写这一节，
// `node scripts/check.mjs` 却打了勾 —— 因为旧判据是 `chg.includes(version)`，
// 而正文里那句 `magpie ≥ 0.1.1763` 恰好含「0.1.1」。门是绿的，Release 正文却是空的，
// 用户根本看不到这次更新说明。
//
// 现在的判据是「段首标题」语义：`## <version>`，且版本号按字面量比对、带右边界。
//
// 这里**不 mock**：直接跑真的 `scripts/check.mjs <临时目录>`，只断言那一行结果。
// 临时目录里只有 package.json + CHANGELOG.md（不是完整插件），其余检查必然红 ——
// 与本节无关，所以按行内容过滤，不看整体退出码。

import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECK = join(HERE, "..", "scripts", "check.mjs")

/** 输出里的 ANSI 颜色码：断言只看标记（✓ / ✗），不看颜色 */
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "")

/**
 * 在一次性目录里放一个最小仓（package.json + CHANGELOG.md），跑真的 check.mjs。
 * @param {{version: string, changelog: string}} fixture
 * @returns {{mark: "pass"|"fail"|"missing", text: string}} 门 ⑧ 那一行的判定 + 去色后的完整输出
 */
function runCheckGate({ version, changelog }) {
  const dir = mkdtempSync(join(tmpdir(), "check-version-"))
  try {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "fixture-plugin", version }, null, 2)}\n`)
    writeFileSync(join(dir, "CHANGELOG.md"), changelog)

    let out = ""
    try {
      out = execFileSync(process.execPath, [CHECK, dir], { encoding: "utf8" })
    } catch (error) {
      // exit 1 是常态（这个最小仓过不了别的检查），stdout 挂在 error 上
      out = `${error.stdout ?? ""}${error.stderr ?? ""}`
    }

    const text = strip(out)
    const line = text.split("\n").find((l) => l.includes(`CHANGELOG 有 ${version} 这一段`)) ?? ""
    const mark = line.includes("✓") ? "pass" : line.includes("✗") ? "fail" : "missing"
    return { mark, text }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("真标题通过：有 `## 0.1.1` 这一节 —— 正文另写上 0.1.1763 也不影响", () => {
  const { mark } = runCheckGate({
    version: "0.1.1",
    changelog: ["# 更新记录", "", "## 0.1.1 — 2026-11-09", "", "- 修好了签到", "", "## 0.1.0 — 2026-11-09", "", "- 首个版本（magpie ≥ 0.1.1763）", ""].join("\n"),
  })
  assert.equal(mark, "pass")
})

test("正文子串不算：只有 `magpie ≥ 0.1.1763`、没有 0.1.1 标题 —— 必须失败（旧实现这里是假绿）", () => {
  const { mark, text } = runCheckGate({
    version: "0.1.1",
    changelog: ["# 更新记录", "", "## 0.1.0 — 2026-11-09", "", "- magpie ≥ 0.1.1763（稳定渠道 0.1.1327 亦可用）", ""].join("\n"),
  })
  assert.equal(mark, "fail")
  // 失败时要把「怎么改」说清楚，别让人对着一个红叉猜
  assert.match(text, /在 CHANGELOG 顶部加一节标题/)
})

test("前缀不能替版本：`## 0.1.10` 不给 0.1.1 过关", () => {
  const { mark } = runCheckGate({
    version: "0.1.1",
    changelog: ["# 更新记录", "", "## 0.1.10 — 2026-11-09", "", "- 另一个版本", ""].join("\n"),
  })
  assert.equal(mark, "fail")
})

test("版本号按字面量比对：`## 0.1x1` 不给 0.1.1 过关（点号必须转义）", () => {
  const { mark } = runCheckGate({
    version: "0.1.1",
    changelog: ["# 更新记录", "", "## 0.1x1 — 2026-11-09", "", "- 点号不转义时这里会被误判通过", ""].join("\n"),
  })
  assert.equal(mark, "fail")
})

test("带后缀的版本号：`## 0.1.1-rc.1` 只认它自己，不给 0.1.1 过关", () => {
  const rcOnly = runCheckGate({
    version: "0.1.1",
    changelog: ["# 更新记录", "", "## 0.1.1-rc.1 — 2026-11-09", ""].join("\n"),
  })
  assert.equal(rcOnly.mark, "fail")

  const exact = runCheckGate({
    version: "0.1.1-rc.1",
    changelog: ["# 更新记录", "", "## 0.1.1-rc.1 — 2026-11-09", ""].join("\n"),
  })
  assert.equal(exact.mark, "pass")
})
