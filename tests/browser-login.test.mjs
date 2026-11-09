// 受控浏览器登录：候选排序、pickCookie、等文件。真启动浏览器不在单测里跑。
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const {
  browserCandidates,
  findBrowser,
  registryAppPath,
  resetBrowserCache,
  selectCookies,
  waitForFile,
  _internal,
} = await import("../src/browser-login.mjs")

test("Windows 候选：注册表命中优先，Chrome 在 Edge 前，国产浏览器在列", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
    APPDATA: "C:\\Users\\x\\AppData\\Roaming",
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  }
  const lookup = (exe) => (exe === "360ChromeX.exe" ? "C:\\360\\360ChromeX.exe" : "")
  const list = browserCandidates({ platform: "win32", env, lookup })
  const names = list.map((b) => b.name)
  assert.equal(list[0].path, "C:\\360\\360ChromeX.exe", "注册表命中的 360 极速应排最前")
  assert.ok(names.indexOf("Chrome") < names.indexOf("Edge"), "Chrome 在 Edge 之前")
  assert.ok(names.some((n) => n.includes("QQ")), "QQ 浏览器在候选里")
  assert.ok(list.every((b) => b.path), "候选不应有空路径")
})

test("findBrowser 只返回真实存在的候选；找不到返回 null", () => {
  const env = { PROGRAMFILES: "C:\\PF", LOCALAPPDATA: "C:\\L" }
  const chrome = join("C:\\PF", "Google", "Chrome", "Application", "chrome.exe")
  const found = findBrowser({
    platform: "win32",
    env,
    lookup: () => "",
    exists: (p) => p === chrome,
  })
  assert.equal(found.name, "Chrome")
  assert.equal(findBrowser({ platform: "win32", env, lookup: () => "", exists: () => false }), null)
})

// ── M-2：注册表查询的进程噪声与同步阻塞 ────────────────────────────────
//
// 现场：默认登录每点一次「+」spawn 56 个 reg 子进程、往 stderr 刷 56 行中文
// 「错误: 系统找不到指定的注册表项或值。」，并同步阻塞约 1 秒。

test("registryAppPath：reg 的 stderr 丢弃、不弹窗、带上限时；命中路径原样返回", () => {
  const calls = []
  const exePath = join("C:\\fake", "bin", "msedge.exe")
  // reg query 的真实输出形状（含中文错误以外的正常行）
  const exec = (command, args, options) => {
    calls.push({ command, args, options })
    return "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe\r\n    (Default)    REG_SZ    C:\\fake\\bin\\msedge.exe\r\n\r\n"
  }
  const found = registryAppPath("msedge.exe", { platform: "win32", exec, exists: (p) => p === exePath })

  assert.equal(found, exePath)
  assert.ok(calls.length >= 1, "应当真的去查注册表")
  for (const call of calls) {
    assert.equal(call.command, "reg")
    // ① 查不到的键会往父进程 stderr 打中文错误 —— 必须丢掉
    assert.deepEqual(call.options.stdio, ["ignore", "pipe", "ignore"], "stderr 必须丢掉（否则 56 行噪声）")
    // ② 同步子进程不能弹控制台窗口
    assert.equal(call.options.windowsHide, true, "同步子进程必须 windowsHide")
    // ③ 没有整体上限时最坏会挂住 authorize()
    assert.equal(call.options.timeout, 5000)
    assert.equal(call.options.encoding, "utf8")
  }

  // 非 Windows 一律空串，且不起子进程
  const offPlatform = []
  assert.equal(registryAppPath("chrome.exe", { platform: "darwin", exec: (...args) => offPlatform.push(args) }), "")
  assert.deepEqual(offPlatform, [])
})

test("findBrowser 先查静态候选：静态路径命中时一次注册表都不查", () => {
  const chromePath = join("C:\\PF", "Google", "Chrome", "Application", "chrome.exe")
  let lookups = 0
  const found = findBrowser({
    platform: "win32",
    env: { PROGRAMFILES: "C:\\PF" },
    lookup: () => {
      lookups += 1
      return ""
    },
    exists: (p) => p === chromePath,
  })
  assert.equal(found?.name, "Chrome")
  assert.equal(lookups, 0, "静态路径命中后不该再 spawn reg（那 1 秒同步阻塞就是这么来的）")
})

test("findBrowser 静态全部没命中才回退注册表（注册表路径仍会被采用）", () => {
  const edgePath = join("C:\\Edge", "msedge.exe")
  let lookups = 0
  const found = findBrowser({
    platform: "win32",
    env: { PROGRAMFILES: "C:\\PF" },
    lookup: (exe) => {
      lookups += 1
      return exe === "msedge.exe" ? edgePath : ""
    },
    exists: (p) => p === edgePath,
  })
  assert.equal(found?.path, edgePath)
  assert.ok(lookups > 0, "静态没命中时必须能回退到注册表")
})

test("默认 findBrowser() 记忆化：一次进程只发现一次；resetBrowserCache 可重置", () => {
  resetBrowserCache()
  assert.equal(_internal.hasDefaultBrowserCache(), false, "reset 后应为空")

  const first = findBrowser()
  assert.equal(_internal.hasDefaultBrowserCache(), true, "默认调用后应写入缓存")
  const second = findBrowser()
  // 引用相等即可证明走了缓存（没命中时两者都是 null，同样成立）
  assert.equal(second, first, "第二次默认调用必须复用第一次的发现结果")

  resetBrowserCache()
  assert.equal(_internal.hasDefaultBrowserCache(), false, "resetBrowserCache 必须真的清空")
})

test("自定义 exists / lookup / env / platform 的调用必须绕过缓存（测试串扰）", () => {
  resetBrowserCache()
  const chromePath = join("C:\\PF", "Google", "Chrome", "Application", "chrome.exe")
  const custom = findBrowser({
    platform: "win32",
    env: { PROGRAMFILES: "C:\\PF" },
    lookup: () => "",
    exists: (p) => p === chromePath,
  })
  assert.equal(custom?.name, "Chrome", "注入的 exists 必须真的被用上")
  assert.equal(_internal.hasDefaultBrowserCache(), false, "带参数的调用不许写默认缓存")
})

test("selectCookies 只取需要的名字，忽略空值，拼成 Cookie header", () => {
  const cookies = [
    { name: "sid", value: "abc" },
    { name: "uid", value: "42" },
    { name: "other", value: "no" },
    { name: "empty", value: "" },
  ]
  assert.deepEqual(selectCookies(cookies, ["sid", "uid", "empty"]), {
    header: "sid=abc; uid=42",
    found: { sid: "abc", uid: "42" },
  })
  assert.deepEqual(selectCookies(null, ["sid"]), { header: "", found: {} })
})

test("waitForFile：文件出现返回 true，超时返回 false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "magpie-browser-"))
  const file = join(dir, "ready")
  const pending = waitForFile(file, 500, 20)
  setTimeout(() => writeFileSync(file, "1"), 50)
  assert.equal(await pending, true)
  assert.equal(await waitForFile(join(dir, "missing"), 30, 10), false)
})
