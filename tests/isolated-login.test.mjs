// tests/isolated-login.test.mjs —— 默认 OAuth 的「隔离浏览器」启动器
//
// 全程假 spawn / 假 fs / 假 browser：不启动真浏览器、不读写任何真实 profile、不碰网络。
// 每个用例钉住 src/isolated-login.mjs 顶部的一条边界：
//   · 每次登录一份全新 user-data-dir（日常会话/Cookie 不会带进来）
//   · 绝不指向、绝不删除日常浏览器 profile
//   · 不开调试端口，也不复用现成的取 Cookie 通路
//   · close 只杀本次启动的 child；重复 close 幂等
//   · 启动失败 / 超时 / 取消都当场清理，不留子进程与定时器
//   · 并发登录各自隔离

import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const mod = await import("../src/isolated-login.mjs")
const { launchIsolatedLogin, buildIsolatedArgs, isDailyProfilePath, _internal } = mod

const URL_AUTH = "https://example.test/oauth/authorize?client_id=x&state=y"
const BROWSER = { name: "Chrome", path: "C:\\fake\\bin\\chrome.exe" }
// ⚠ 这里刻意不用 C:\Users\… 形状：check.mjs 会把「硬编码本机用户路径」记成警告。
const TMP_ROOT = join("C:\\fakehome", "tmp")
const ENV = {
  USERPROFILE: "C:\\fakehome\\tester",
  LOCALAPPDATA: "C:\\fakehome\\tester\\AppData\\Local",
  APPDATA: "C:\\fakehome\\tester\\AppData\\Roaming",
}
const CHROME_USER_DATA = "C:\\fakehome\\tester\\AppData\\Local\\Google\\Chrome\\User Data"

// ── 假件 ──────────────────────────────────────────────────────────────

function makeChild({ mode = "spawn", pid = 4242, exitOnKill = true } = {}) {
  const ee = new EventEmitter()
  const child = {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    killCount: 0,
    signals: [],
    kill(signal = "SIGTERM") {
      child.killCount += 1
      child.signals.push(signal)
      child.killed = true
      if (!exitOnKill) return true
      setImmediate(() => {
        if (child.exitCode !== null) return
        child.exitCode = 0
        child.signalCode = signal
        ee.emit("exit", 0, signal)
      })
      return true
    },
    on: (event, fn) => ee.on(event, fn),
    once: (event, fn) => ee.once(event, fn),
    removeListener: (event, fn) => ee.removeListener(event, fn),
    emitExit(code = 0, signal = null) {
      if (child.exitCode === null) {
        child.exitCode = code
        child.signalCode = signal
      }
      ee.emit("exit", code, signal)
    },
  }
  if (mode === "spawn") setImmediate(() => ee.emit("spawn", child))
  if (mode === "error") {
    setImmediate(() => {
      const error = new Error("spawn C:\\fake\\bin\\chrome.exe ENOENT")
      error.code = "ENOENT"
      ee.emit("error", error)
    })
  }
  // mode === "hung"：既不 spawn 也不 error，专门用来验证启动超时
  return child
}

function fakeSpawn({ mode = "spawn", throwError = null, exitOnKill = true } = {}) {
  const calls = []
  const spawn = (command, args, options) => {
    if (throwError) throw throwError
    const child = makeChild({ mode, exitOnKill })
    calls.push({ command, args, options, child })
    return child
  }
  return { spawn, calls }
}

function fakeFs({ firstDir = null } = {}) {
  const mkdtempCalls = []
  const removeCalls = []
  let n = 0
  const mkdtemp = (prefix) => {
    mkdtempCalls.push(prefix)
    if (firstDir) return firstDir
    n += 1
    return `${prefix}${n.toString(36)}x7k`
  }
  const removeDir = (dir) => {
    removeCalls.push(dir)
  }
  return { mkdtemp, removeDir, mkdtempCalls, removeCalls }
}

function launchWith({ fs = fakeFs(), sp = fakeSpawn(), ...options } = {}) {
  return launchIsolatedLogin({
    url: URL_AUTH,
    browser: BROWSER,
    tmpdir: TMP_ROOT,
    env: ENV,
    spawn: sp.spawn,
    mkdtemp: fs.mkdtemp,
    removeDir: fs.removeDir,
    ...options,
  })
}

// ── 参数面 ────────────────────────────────────────────────────────────

test("启动参数：四个必需开关 + 独立 user-data-dir，不开调试端口、不指定 profile-directory", () => {
  const args = buildIsolatedArgs({ userDataDir: join(TMP_ROOT, "x"), url: URL_AUTH })
  for (const flag of [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
  ]) {
    assert.ok(args.includes(flag), `缺少必需开关 ${flag}`)
  }
  assert.deepEqual(
    args.filter((a) => a.startsWith("--user-data-dir=")),
    [`--user-data-dir=${join(TMP_ROOT, "x")}`],
    "user-data-dir 只能出现一次",
  )
  assert.equal(args.at(-1), URL_AUTH, "URL 必须是最后一个非开关参数")
  assert.ok(
    args.every((a) => !/remote-debugging|inspector|devtools/i.test(a)),
    "非必要不开 CDP 调试端口",
  )
  assert.ok(args.every((a) => !a.startsWith("--profile-directory")), "不指定日常 profile 名字")
})

// ── 每次一份全新 profile ───────────────────────────────────────────────

test("两次登录各开一个新的 user-data-dir，且都落在临时根目录下", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()
  const a = await launchWith({ fs, sp })
  const b = await launchWith({ fs, sp })

  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.notEqual(a.userDataDir, b.userDataDir, "两次登录不能共用 profile")
  assert.ok(a.userDataDir.startsWith(TMP_ROOT), "必须落在临时根目录")
  assert.ok(b.userDataDir.startsWith(TMP_ROOT), "必须落在临时根目录")
  assert.ok(a.userDataDir.includes("phanthy-isolated-login-"), "目录名要能一眼看出用途")

  assert.equal(sp.calls.length, 2, "每次登录各 spawn 一次")
  assert.equal(sp.calls[0].command, BROWSER.path)
  assert.equal(sp.calls[0].options.stdio, "ignore")
  assert.deepEqual(sp.calls[0].args, a.args)
  assert.ok(sp.calls[0].args.includes(`--user-data-dir=${a.userDataDir}`))
  assert.ok(sp.calls[1].args.includes(`--user-data-dir=${b.userDataDir}`))
  assert.equal(a.pid, sp.calls[0].child.pid)
  assert.equal(a.browser.name, "Chrome")

  await a.close()
  await b.close()
})

test("user-data-dir 不落在日常浏览器 profile 里；若被指向那里，拒绝启动且绝不删除", async () => {
  // ① 正常路径：明显不是日常 profile
  const ok = await launchWith()
  assert.equal(isDailyProfilePath(ok.userDataDir, ENV), false)
  await ok.close()

  // ② 注入「日常 profile 目录」当临时目录 → 必须拒绝，且不许 spawn、不许 rm
  const fs = fakeFs({ firstDir: CHROME_USER_DATA })
  const sp = fakeSpawn()
  const denied = await launchWith({ fs, sp })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /日常浏览器 profile/)
  assert.equal(sp.calls.length, 0, "不能把日常 profile 交给浏览器")
  assert.deepEqual(fs.removeCalls, [], "绝不删除用户的真实 profile")
  await denied.close()
  assert.deepEqual(fs.removeCalls, [], "close 也不许删")
})

test("isDailyProfilePath 认得各家日常 profile，认不出临时目录", () => {
  for (const dir of [
    CHROME_USER_DATA,
    "C:\\fakehome\\tester\\AppData\\Local\\Microsoft\\Edge\\User Data",
    join("C:\\fakehome", "tester", "AppData", "Local", "Google", "Chrome", "User Data", "Default"),
    "/home/t/.config/google-chrome",
    "/home/t/.config/chromium",
    "/Users/t/Library/Application Support/Google/Chrome",
  ]) {
    assert.equal(isDailyProfilePath(dir, ENV), true, `应当认出：${dir}`)
  }
  for (const dir of [join(TMP_ROOT, "phanthy-isolated-login-abc"), join(TMP_ROOT, "fresh-chrome")]) {
    assert.equal(isDailyProfilePath(dir, ENV), false, `不应误报：${dir}`)
  }
})

// ── close 的边界 ──────────────────────────────────────────────────────

test("close 只杀本次启动的 child，不碰另一个并发登录的浏览器", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()
  const a = await launchWith({ fs, sp })
  const b = await launchWith({ fs, sp })

  await a.close()

  assert.equal(sp.calls[0].child.killCount, 1, "杀掉自己的 child")
  assert.equal(sp.calls[1].child.killCount, 0, "另一个登录的浏览器一律不碰")
  assert.deepEqual(fs.removeCalls, [a.userDataDir], "只删自己的目录")
  assert.equal(a.closed, true)
  assert.equal(b.closed, false)
  assert.equal(b.exited, false)

  await b.close()
  assert.equal(sp.calls[1].child.killCount, 1)
})

test("重复 close 幂等：只杀一次、只删一次，cleanup 是 close 的别名", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()
  const h = await launchWith({ fs, sp })

  assert.equal(typeof h.cleanup, "function")
  const first = await h.close()
  const second = await h.close()
  await h.close()
  await h.cleanup()

  assert.equal(sp.calls[0].child.killCount, 1)
  assert.equal(fs.removeCalls.length, 1)
  assert.deepEqual(first, second)
  assert.deepEqual(first, { killed: true, removedDir: true })
})

test("用户自己关掉浏览器后临时目录自动清掉；随后 close 不再杀进程", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()
  const baseline = _internal.activeTimers()
  const h = await launchWith({ fs, sp })

  sp.calls[0].child.emitExit(0, null)
  assert.equal(h.exited, true)
  assert.equal(fs.removeCalls.length, 1, "退出即清目录，不留垃圾")

  await h.close()
  assert.equal(h.closed, true)
  assert.equal(sp.calls[0].child.killCount, 0, "已经退出的进程不再 kill")
  assert.equal(fs.removeCalls.length, 1, "不重复删")
  assert.equal(_internal.activeTimers(), baseline)
})

test("关窗时进程赖着不走：有界等待后补 SIGKILL，并清掉目录与定时器", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn({ mode: "spawn", exitOnKill: false })
  const baseline = _internal.activeTimers()
  const h = await launchWith({ fs, sp, closeTimeoutMs: 20 })

  const result = await h.close()

  assert.deepEqual(sp.calls[0].child.signals, ["SIGTERM", "SIGKILL"], "先礼后兵")
  assert.equal(result.killed, true)
  assert.equal(result.removedDir, true)
  assert.equal(fs.removeCalls.length, 1)
  assert.equal(_internal.activeTimers(), baseline, "有界等待用的是会清掉的定时器")
})

// ── 失败 / 超时 / 取消 ────────────────────────────────────────────────

test("spawn 报错（ENOENT）：清理临时目录、不留定时器、失败句柄的 close 仍然安全", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn({ mode: "error" })
  const baseline = _internal.activeTimers()
  const h = await launchWith({ fs, sp })

  assert.equal(h.ok, false)
  assert.match(h.error, /ENOENT|启动浏览器失败/)
  assert.deepEqual(fs.removeCalls, [h.userDataDir], "失败也要清理临时目录")
  assert.equal(_internal.activeTimers(), baseline, "不留定时器")

  const r1 = await h.close()
  const r2 = await h.close()
  assert.equal(fs.removeCalls.length, 1, "失败句柄的 close 不能重复删")
  assert.deepEqual(r1, r2)
  assert.equal(r1.killed, false, "没起来过的进程不 kill")
})

test("spawn 同步抛错：同样清理并返回失败句柄", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn({ throwError: new Error("EACCES 拒绝访问") })
  const h = await launchWith({ fs, sp })

  assert.equal(h.ok, false)
  assert.match(h.error, /EACCES/)
  assert.equal(fs.removeCalls.length, 1)
  assert.equal(h.userDataDir, fs.removeCalls[0])
})

test("启动超时有界：超时即杀掉半启动进程并清理，不遗留定时器", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn({ mode: "hung" })
  const baseline = _internal.activeTimers()
  const h = await launchWith({ fs, sp, startupTimeoutMs: 25 })

  assert.equal(h.ok, false)
  assert.match(h.error, /超时/)
  assert.equal(sp.calls[0].child.killCount, 1, "半启动的进程也要收掉")
  assert.equal(fs.removeCalls.length, 1)
  assert.equal(_internal.activeTimers(), baseline)
})

test("取消信号（abort）：启动中断、清理干净、不留定时器", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn({ mode: "hung" })
  const baseline = _internal.activeTimers()
  const controller = new AbortController()

  const pending = launchWith({ fs, sp, signal: controller.signal, startupTimeoutMs: 5_000 })
  controller.abort()
  const h = await pending

  assert.equal(h.ok, false)
  assert.match(h.error, /取消/)
  assert.equal(fs.removeCalls.length, 1)
  assert.equal(sp.calls[0].child.killCount, 1)
  assert.equal(_internal.activeTimers(), baseline)
  await h.close()
  assert.equal(fs.removeCalls.length, 1)
})

test("找不到浏览器 / 缺 url：直接失败，不建目录、不 spawn", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()

  const noUrl = await launchWith({ fs, sp, url: "" })
  assert.equal(noUrl.ok, false)
  assert.match(noUrl.error, /url/i)

  const noBrowser = await launchIsolatedLogin({
    url: URL_AUTH,
    findBrowser: () => null,
    tmpdir: TMP_ROOT,
    env: ENV,
    spawn: sp.spawn,
    mkdtemp: fs.mkdtemp,
    removeDir: fs.removeDir,
  })
  assert.equal(noBrowser.ok, false)
  assert.match(noBrowser.error, /Chromium|浏览器/)
  assert.deepEqual(fs.mkdtempCalls, [], "没浏览器就别建目录")
  assert.equal(sp.calls.length, 0)
})

test("未显式给 browser 时用注入的 findBrowser 发现路径（复用 browser-login，不取 Cookie）", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()
  const h = await launchIsolatedLogin({
    url: URL_AUTH,
    findBrowser: () => BROWSER,
    tmpdir: TMP_ROOT,
    env: ENV,
    spawn: sp.spawn,
    mkdtemp: fs.mkdtemp,
    removeDir: fs.removeDir,
  })
  assert.equal(h.ok, true)
  assert.equal(sp.calls[0].command, BROWSER.path)
  await h.close()
})

// ── 并发隔离 ──────────────────────────────────────────────────────────

test("并发登录各自隔离：三个目录互不相同，关一个不影响另外两个", async () => {
  const fs = fakeFs()
  const sp = fakeSpawn()
  const [a, b, c] = await Promise.all([launchWith({ fs, sp }), launchWith({ fs, sp }), launchWith({ fs, sp })])

  const dirs = new Set([a.userDataDir, b.userDataDir, c.userDataDir])
  assert.equal(dirs.size, 3, "三个登录三份 profile")
  assert.deepEqual(fs.mkdtempCalls.length, 3)

  await b.close()
  assert.equal(sp.calls[1].child.killCount, 1)
  assert.equal(sp.calls[0].child.killCount, 0)
  assert.equal(sp.calls[2].child.killCount, 0)
  assert.ok(!fs.removeCalls.includes(a.userDataDir))
  assert.ok(!fs.removeCalls.includes(c.userDataDir))

  await a.close()
  await c.close()
  assert.deepEqual([...fs.removeCalls].sort(), [...dirs].sort())
})

// ── 静态边界 ──────────────────────────────────────────────────────────

test("源码边界：不启用调试端口 / 不取 Cookie / 不复制 profile；导出只有函数 + _internal", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/isolated-login.mjs", import.meta.url)), "utf8")
  // 注释里会写「为什么不做这些」，所以边界只查代码本身。
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+\/\/[^\n]*$/gm, "")

  assert.ok(!/remote-debugging/i.test(code), "不许出现调试端口开关")
  assert.ok(!/getAllCookies|Network\.enable/i.test(code), "不许取 Cookie")
  assert.ok(!/chromiumLogin|cdpCookies|selectCookies/.test(code), "不许复用取 Cookie 的通路")
  assert.ok(!/localStorage|local storage/i.test(code), "不碰 LocalStorage")
  assert.ok(!/\bcpSync\b|\bcopyFileSync?\b|recursive-copy/.test(code), "不复制任何 profile")
  assert.ok(/from "\.\/browser-login\.mjs"/.test(code), "复用 browser-login 的浏览器发现")
  assert.ok(/findBrowser/.test(code), "只复用 findBrowser")

  for (const [name, value] of Object.entries(mod)) {
    assert.ok(typeof value === "function" || name === "_internal", `多余的对象导出：${name}`)
  }
})

// ── L-2：authorize 的异常路径必须关掉 loopback ────────────────────────
//
// 现场：注入 `isolatedLogin: async () => { throw … }` 后，index.mjs 的
// authorize 只关 `ok:false` 分支，抛异常那条把 loopback Server 留到 300s
// 超时 —— 端口泄漏、进程退不出去（review 实测 [still running after 120000ms]）。

/** 当前进程里还活着的 loopback HTTP Server（只看 127.0.0.1） */
function loopbackServers() {
  const handles = typeof process._getActiveHandles === "function" ? process._getActiveHandles() : []
  return handles.filter((handle) => {
    if (handle?.constructor?.name !== "Server") return false
    try {
      return handle.address?.()?.address === "127.0.0.1"
    } catch {
      return false
    }
  })
}

test("authorize：openIsolatedLogin 抛异常 → 返回 failed 且关掉 loopback（不留 Server）", async () => {
  const home = mkdtempSync(join(tmpdir(), "pw-l2-"))
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    // 动态 import：index.mjs 的模块级缓存根目录由 HOME 决定，必须改完 env 再加载。
    const { PhanthyCodeAuthPlugin } = await import(`../index.mjs?l2=${Date.now()}`)
    const plugin = await PhanthyCodeAuthPlugin(
      {},
      {
        isolatedLogin: async () => {
          throw new Error("boom-browser")
        },
        fetch: async () => {
          throw new TypeError("authorize 异常路径不该发任何请求")
        },
      },
    )
    const baseline = loopbackServers().length
    const method = plugin.auth.methods.find((m) => m.type === "oauth")

    const result = await method.authorize()

    assert.equal(result.type, "failed", "异常必须变成可行动的 failed，而不是把异常抛给宿主")
    assert.match(result.error, /boom-browser/)

    // close 之后端口释放是异步的：给一个 tick 再断言。
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(
      loopbackServers().length,
      baseline,
      "异常路径必须 listener.close()：残留的 127.0.0.1 Server 会吊住进程直到 300s 超时",
    )
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME
    else process.env.HOME = previous.HOME
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previous.USERPROFILE
    rmSync(home, { recursive: true, force: true })
  }
})
