// src/isolated-login.mjs —— 默认 OAuth 的「隔离浏览器」启动器
//
// 要解决的事：授权页如果用的是用户日常浏览器里的会话，OAuth 加号会**直接跳过登录**，
// 换回来的 code 属于旧账号 —— 用户以为自己加了新号，实际还是原来那个。
// 所以每点一次加号，都必须开一份**干净的浏览器配置**：
//   · 每次调用新建一个 os.tmpdir() 下的唯一目录当 user-data-dir（mkdtemp 保证唯一）
//   · 绝不读、不复制、不删除日常 profile / Cookie / LocalStorage
//   · 只把授权 URL 交给这个进程；**不开放任何调试端口**（不需要，也不该开），
//     也不复用现成的「连上 CDP 取 Cookie」通路
//   · 返回一个句柄给 callback 的 finally：关掉**本次**启动的进程 + 删掉本次的目录
//
// 设计边界（每一条都有 tests/isolated-login.test.mjs 钉住）：
//   · authorize 只需要「马上把窗口打开」：这里只等到进程真正起来（毫秒级），
//     **绝不等用户登录** —— 等用户是 callback 的事。
//   · 只能 kill 自己 spawn 出来的 child；绝不做按进程名 / 按端口的批量清理。
//   · 启动失败（没浏览器 / spawn 抛错 / ENOENT / 启动超时 / 中途取消）一律先清垃圾，
//     再返回 ok:false 的句柄；失败句柄与成功句柄同形，close() 重复调用安全。
//   · 不留常驻定时器：启动计时器在 settle 时清掉；close 里等退出用的计时器有界且清掉。
//   · 临时目录**不指向日常 profile**：mkdtemp 落在 tmpdir，且落点会被 isDailyProfilePath
//     复核一遍；万一指向日常 profile，直接拒绝启动，并且**绝不删除**那个目录。

import { spawn as nodeSpawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir as osTmpdir } from "node:os"
import { join } from "node:path"

// 只复用「发现浏览器路径」这一条；browser-login 的取 Cookie 通路（chromiumLogin）不启用。
import { findBrowser } from "./browser-login.mjs"

const TEMP_PREFIX = "phanthy-isolated-login-"
const STARTUP_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 3_000
// 启动后等「这份 profile 真的被用上了」的上限：Chromium 建 `Local State` 是毫秒级，
// 等不到就说明参数被别的实例接管了（单实例国产浏览器最常见）。
const PROFILE_READY_MS = 3_000
const PROFILE_POLL_MS = 50

// Chromium 的「干净启动」开关。少一个都可能弹首启/推荐页，或让扩展把会话带进来。
const REQUIRED_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
]

/** 日常浏览器 profile 的落点特征：命中即视为「不是我们的临时目录」。 */
const DAILY_PROFILE_PATTERNS = [
  /[\\/]google[\\/]chrome[\\/]user data(?:[\\/]|$)/i,
  /[\\/]microsoft[\\/]edge[\\/]user data(?:[\\/]|$)/i,
  /[\\/]bravesoftware[\\/][^\\/]+[\\/]user data(?:[\\/]|$)/i,
  /[\\/]chromium[\\/]user data(?:[\\/]|$)/i,
  /[\\/]vivaldi[\\/](?:user data|default)(?:[\\/]|$)/i,
  /[\\/]360chrome[^\\/]*[\\/]user data(?:[\\/]|$)/i,
  /[\\/]tencent[\\/]qqbrowser[\\/]user data(?:[\\/]|$)/i,
  /[\\/]user data[\\/](?:default|profile \d+)(?:[\\/]|$)/i,
  /[\\/]\.config[\\/](?:google-chrome|chromium|brave-browser|microsoft-edge|vivaldi)(?:[\\/]|$)/i,
  /[\\/]library[\\/]application support[\\/](?:google[\\/]chrome|chromium|brave browser|microsoft edge|vivaldi)(?:[\\/]|$)/i,
]

// 本模块自己开的定时器（供测试断言「没有长驻定时器」）。
const liveTimers = new Set()

function startTimer(fn, ms, { ref = true } = {}) {
  const id = setTimeout(() => {
    liveTimers.delete(id)
    fn()
  }, ms)
  // ⚠ 默认必须**保持引用**（ref）：本模块的定时器都是「有界等待」的那个句柄 ——
  //   `waitExit()` / 启动超时都是 `await Promise.race([promise, 这个定时器])`。
  //   一旦 unref，事件循环里没有别的句柄时会先结束，await 变成永远不落地的
  //   Promise（Linux CI 实测：`Promise resolution is still pending but the event
  //   loop has already resolved`，同文件后续用例全被 cancelledByParent 掐掉）。
  //   泄漏靠 `stopTimer()` 在 finally 里清零，而不是靠 unref。
  if (ref) id.ref?.()
  else id.unref?.()
  liveTimers.add(id)
  return id
}

function stopTimer(id) {
  if (id === null || id === undefined) return
  clearTimeout(id)
  liveTimers.delete(id)
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 目标目录是不是用户的日常浏览器 profile？
 * 命中就绝不能拿来当 user-data-dir，更不能删。
 *
 * @param {string} dir
 * @param {Record<string,string|undefined>} [env]
 */
export function isDailyProfilePath(dir, env = process.env) {
  if (typeof dir !== "string") return false
  const value = dir.replace(/[\\/]+$/, "")
  if (value === "") return false
  for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    const home = env?.[key]
    if (typeof home === "string" && home !== "" && value.toLowerCase() === home.replace(/[\\/]+$/, "").toLowerCase()) {
      return true
    }
  }
  return DAILY_PROFILE_PATTERNS.some((re) => re.test(value))
}

/**
 * 本次启动的参数（纯函数，方便断言）。
 * 顺序固定：user-data-dir → 干净启动开关 → 授权 URL（URL 必须是最后一个非开关参数）。
 */
export function buildIsolatedArgs({ userDataDir, url } = {}) {
  if (typeof userDataDir !== "string" || userDataDir === "") {
    throw new TypeError("buildIsolatedArgs: 需要 userDataDir")
  }
  if (typeof url !== "string" || url.trim() === "") {
    throw new TypeError("buildIsolatedArgs: 需要 url")
  }
  return [`--user-data-dir=${userDataDir}`, ...REQUIRED_FLAGS, url]
}

/**
 * 用一次性 profile 打开授权页，返回清理句柄。
 *
 * ⚠ 只等「进程起来」（毫秒级），不等用户登录 —— 等用户的是 callback。
 *
 * @param {{
 *   url: string,
 *   browser?: {name?:string, path:string} | null,
 *   findBrowser?: () => {name?:string, path:string} | null,
 *   spawn?: Function,
 *   mkdtemp?: (prefix:string) => string,
 *   removeDir?: (dir:string) => void,
 *   tmpdir?: string,
 *   env?: Record<string,string|undefined>,
 *   startupTimeoutMs?: number,
 *   closeTimeoutMs?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   error: string | null,
 *   browser: {name?:string, path:string} | null,
 *   userDataDir: string | null,
 *   args: string[],
 *   child: object | null,
 *   pid: number | null,
 *   exited: boolean,
 *   closed: boolean,
 *   close: () => Promise<{killed:boolean, removedDir:boolean}>,
 *   cleanup: () => Promise<{killed:boolean, removedDir:boolean}>,
 * }>}
 */
export async function launchIsolatedLogin(options = {}) {
  const {
    url,
    browser: givenBrowser = null,
    findBrowser: discoverBrowser = findBrowser,
    spawn: spawnImpl = nodeSpawn,
    mkdtemp: mkdtempImpl = mkdtempSync,
    removeDir = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    tmpdir = osTmpdir(),
    env = process.env,
    startupTimeoutMs = STARTUP_TIMEOUT_MS,
    closeTimeoutMs = CLOSE_TIMEOUT_MS,
    // 启动后校验「这次真的用了我们新建的 profile」。测试可以注入片假件，生产必须开：
    // 单实例浏览器（360 / QQ / 搜狗…）会把参数转交给已运行的实例，此时进程会立刻退出、
    // 授权页仍然是日常会话 —— 不校验就等于什么都没隔离。
    verifyProfile = true,
    exists = existsSync,
    profileReadyMs = PROFILE_READY_MS,
    signal,
  } = options

  /** @type {{ok:boolean,error:string|null,browser:any,userDataDir:string|null,args:string[],child:any,exited:boolean,closed:boolean}} */
  const state = {
    ok: false,
    error: null,
    browser: givenBrowser ?? null,
    userDataDir: null,
    args: [],
    child: null,
    exited: false,
    closed: false,
  }
  const closeResult = { killed: false, removedDir: false }
  let dirRemoved = false
  let dirKept = false
  let startupTimer = null
  let startSettled = false
  let resolveStart = () => {}
  let resolveExit = () => {}
  const startPromise = new Promise((resolve) => {
    resolveStart = resolve
  })
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve
  })

  function settleStart(result) {
    if (startSettled) return
    startSettled = true
    stopTimer(startupTimer)
    startupTimer = null
    resolveStart(result)
  }

  function removeTempDir() {
    if (dirRemoved || dirKept) return dirRemoved
    if (typeof state.userDataDir !== "string" || state.userDataDir === "") return false
    try {
      removeDir(state.userDataDir)
    } catch {
      // ⚠ 删不掉（Windows 上刚 kill 浏览器最常见 EBUSY）**绝不能谎报成功**：
      //   登录成功后的 profile 里是一份已登录会话，留在 %TEMP% 就是一份可用的 Cookie。
      //   保持 dirRemoved=false，close() 还会再试一次；`rmSync` 自身也带 maxRetries。
      return false
    }
    dirRemoved = true
    return true
  }

  function onExit() {
    if (state.exited) return
    state.exited = true
    resolveExit()
    // 用户自己把窗口关了：顺手清掉本次的临时目录，不留垃圾。
    removeTempDir()
  }

  function onError(error) {
    const message = `启动浏览器失败：${errorText(error)}`
    state.error = message
    if (!startSettled) {
      try {
        state.child?.kill?.()
      } catch {}
      removeTempDir()
      settleStart({ ok: false, error: message })
      return
    }
    // 已经在运行之后才报错：兜底收掉，绝不留孤儿进程 / 目录。
    void close()
  }

  function onSpawn() {
    if (startSettled) return
    state.ok = true
    settleStart({ ok: true })
  }

  function onAbort() {
    const message = "登录启动已取消"
    if (!startSettled) {
      state.error = message
      try {
        state.child?.kill?.()
      } catch {}
      removeTempDir()
      settleStart({ ok: false, error: message })
      return
    }
    void close()
  }

  /** 有界等待进程退出：计时器一定被清掉，不会留下常驻定时器。 */
  async function waitExit(ms) {
    let timer = null
    const clock = new Promise((resolve) => {
      timer = startTimer(resolve, ms)
    })
    try {
      await Promise.race([exitPromise, clock])
    } finally {
      stopTimer(timer)
    }
  }

  /** 有界等待（定时器同样清零，不留常驻句柄）。 */
  async function sleep(ms) {
    await new Promise((resolve) => {
      startTimer(resolve, ms)
    })
  }

  /**
   * 这次新建的 profile 真的被浏览器用上了吗？
   *
   * Chromium 启动后会立刻在自己的 `user-data-dir` 下写 `Local State`。单实例国产浏览器
   * （360 / QQ / 搜狗…）会把命令行参数转交给**已经运行的实例**然后自己退出 ——
   * 此时进程「起来过」，但授权页用的是用户日常的会话，正是这套机制要修的那个 bug。
   * 等不到文件就当成启动失败，让调用方退回默认浏览器。
   */
  async function waitForProfile() {
    if (!verifyProfile) return true
    const marker = join(String(state.userDataDir ?? ""), "Local State")
    const deadline = Date.now() + profileReadyMs
    for (;;) {
      try {
        if (exists(marker)) return true
      } catch {}
      if (state.exited) return false
      const left = deadline - Date.now()
      if (left <= 0) return false
      await sleep(Math.min(PROFILE_POLL_MS, left))
    }
  }

  /** 关闭本次启动的浏览器并删除本次的临时目录。幂等：重复调用只清一次。 */
  async function close() {
    if (state.closed) {
      // ⚠ 上一次删目录失败时（Windows EBUSY 很常见），再 close 必须**还能重试** ——
      //   否则「关窗即删」就成了空话：目录里躺着一份已登录会话，而这句承诺永远不兑现。
      //   成功过就不会再删（幂等），失败过才重试。
      if (!dirRemoved && !dirKept) {
        removeTempDir()
        closeResult.removedDir = dirRemoved
      }
      return closeResult
    }
    state.closed = true
    stopTimer(startupTimer)
    startupTimer = null
    if (typeof signal?.removeEventListener === "function") {
      signal.removeEventListener("abort", onAbort)
    }
    if (!startSettled) settleStart({ ok: false, error: state.error ?? "登录启动已取消" })

    const child = state.child
    // 只处理「确实起起来过」的进程：spawn 失败时没有进程可杀（超时分支已自行收掉）。
    if (state.ok && child && !state.exited && child.exitCode === null && typeof child.kill === "function") {
      try {
        child.kill()
        closeResult.killed = true
        await waitExit(closeTimeoutMs)
        if (!state.exited && child.exitCode === null) {
          try {
            child.kill("SIGKILL")
          } catch {}
        }
      } catch {
        // kill 失败也要继续删目录
      }
    }
    removeTempDir()
    // Windows 上子进程退出与文件句柄释放之间有间隙：再给一次机会。
    // 仍然失败就如实回 `removedDir: false`（默认 removeDir 自己带 maxRetries）。
    if (!dirRemoved) removeTempDir()
    try {
      child?.removeListener?.("exit", onExit)
    } catch {}
    closeResult.removedDir = dirRemoved
    return closeResult
  }

  const handle = {
    get ok() {
      return state.ok
    },
    get error() {
      return state.error
    },
    get browser() {
      return state.browser
    },
    get userDataDir() {
      return state.userDataDir
    },
    get args() {
      return state.args
    },
    get child() {
      return state.child
    },
    get pid() {
      return state.child?.pid ?? null
    },
    get exited() {
      return state.exited
    },
    get closed() {
      return state.closed
    },
    close,
  }
  handle.cleanup = close

  function fail(message) {
    state.ok = false
    state.error = message
    return handle
  }

  if (typeof url !== "string" || url.trim() === "") {
    return fail("缺少授权 URL（url 必填）")
  }

  const browser = givenBrowser ?? discoverBrowser()
  state.browser = browser ?? null
  if (!browser || typeof browser.path !== "string" || browser.path === "") {
    return fail("没有找到可用的 Chromium 浏览器：请先装 Chrome / Edge / Chromium 之一")
  }

  let userDataDir
  try {
    userDataDir = mkdtempImpl(join(tmpdir, TEMP_PREFIX))
  } catch (error) {
    return fail(`临时 profile 目录创建失败：${errorText(error)}`)
  }
  state.userDataDir = userDataDir

  if (isDailyProfilePath(userDataDir, env)) {
    // 只拒绝，不删除 —— 那个目录属于用户的日常浏览器。
    dirKept = true
    return fail(`拒绝把日常浏览器 profile 当临时目录使用：${userDataDir}`)
  }

  let args
  try {
    args = buildIsolatedArgs({ userDataDir, url })
  } catch (error) {
    removeTempDir()
    return fail(errorText(error))
  }
  state.args = args

  let child
  try {
    child = spawnImpl(browser.path, args, { stdio: "ignore", windowsHide: false })
  } catch (error) {
    removeTempDir()
    return fail(`启动浏览器失败：${errorText(error)}`)
  }
  if (!child || typeof child.once !== "function" || typeof child.on !== "function") {
    removeTempDir()
    return fail("启动浏览器失败：没有拿到子进程句柄")
  }
  state.child = child

  child.once("spawn", onSpawn)
  child.once("error", onError)
  child.on("exit", onExit)

  startupTimer = startTimer(() => {
    startupTimer = null
    const message = `浏览器启动超时（${startupTimeoutMs}ms）`
    state.error = message
    try {
      child.kill()
    } catch {}
    removeTempDir()
    settleStart({ ok: false, error: message })
  }, startupTimeoutMs)

  if (signal) {
    if (signal.aborted) onAbort()
    else if (typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true })
    }
  }

  const started = await startPromise
  if (!started.ok) {
    // 各失败分支已经清过；这里兜底一次（removeTempDir 幂等），并把 abort 监听摘掉。
    removeTempDir()
    if (typeof signal?.removeEventListener === "function") {
      signal.removeEventListener("abort", onAbort)
    }
    if (!state.error) state.error = started.error ?? "启动浏览器失败"
    return handle
  }

  // ⚠ 进程「起来过」不等于「这份 profile 被用上了」：单实例浏览器会转交参数后立刻退出，
  //   此时授权页仍是日常会话。校验不过就按启动失败处理，让调用方退回默认浏览器。
  if (!(await waitForProfile())) {
    const message = "浏览器没有使用本次的临时 profile（很可能把参数转交给了已运行的实例）"
    state.ok = false
    state.error = message
    try {
      child.kill()
    } catch {}
    removeTempDir()
    if (typeof signal?.removeEventListener === "function") {
      signal.removeEventListener("abort", onAbort)
    }
    return handle
  }
  return handle
}

export const _internal = {
  TEMP_PREFIX,
  REQUIRED_FLAGS,
  STARTUP_TIMEOUT_MS,
  CLOSE_TIMEOUT_MS,
  PROFILE_READY_MS,
  PROFILE_POLL_MS,
  DAILY_PROFILE_PATTERNS,
  activeTimers: () => liveTimers.size,
  isDailyProfilePath,
  buildIsolatedArgs,
}
