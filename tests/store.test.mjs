// 存储语义锁：原子写、失败保留旧值、权限与厂商时区日历。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Worker } from "node:worker_threads"
import { calendar, readJson, writeJson } from "../src/store.mjs"

function temporaryDirectory(t) {
  const dir = mkdtempSync(join(tmpdir(), "scaffold-store-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("writeJson：并发写不共享临时名，最终 JSON 完整", async (t) => {
  const dir = temporaryDirectory(t)
  const file = join(dir, "nested", "shared.json")
  const storeUrl = new URL("../src/store.mjs", import.meta.url).href
  const source = `
    const { parentPort, workerData } = require("node:worker_threads")
    import(workerData.storeUrl).then(({ writeJson }) => {
      let succeeded = 0
      let iteration = 0
      while (iteration < 30) {
        const written = writeJson(workerData.file, {
          writer: workerData.writer,
          iteration,
          padding: "完整数据".repeat(1000)
        })
        if (written) succeeded += 1
        iteration += 1
      }
      parentPort.postMessage({ succeeded, pid: process.pid })
    }).catch((error) => parentPort.postMessage({ error: String(error) }))
  `

  const results = await Promise.all(Array.from({ length: 8 }, (_, writer) => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { file, storeUrl, writer } })
    let message
    worker.on("message", (value) => { message = value })
    worker.on("error", reject)
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`写入线程退出码：${code}`))
      else resolve(message)
    })
  })))

  for (const result of results) {
    assert.equal(result.error, undefined)
    assert.equal(result.succeeded > 0, true)
    // Windows 并发替换同一目标可能瞬时失败，writeJson 的契约允许返回 false
    if (process.platform !== "win32") assert.equal(result.succeeded, 30)
    assert.equal(result.pid, process.pid, "线程共享进程号，因此临时名还必须有随机部分")
  }
  const saved = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(Number.isInteger(saved.writer), true)
  assert.equal(Number.isInteger(saved.iteration), true)
  assert.equal(saved.padding, "完整数据".repeat(1000))
  assert.deepEqual(readdirSync(dirname(file)).filter((name) => name.endsWith(".tmp")), [])
})

test("writeJson：序列化失败返回 false，旧文件保持不变", (t) => {
  const dir = temporaryDirectory(t)
  const file = join(dir, "old.json")
  const original = { version: 1, items: ["旧数据"] }
  assert.equal(writeJson(file, original), true)

  const circular = {}
  circular.self = circular
  assert.equal(writeJson(file, circular), false)
  assert.deepEqual(readJson(file), original)
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [])
})

test("writeJson：递归创建目标目录，POSIX 权限为目录 0700、文件 0600", (t) => {
  const dir = temporaryDirectory(t)
  const targetDir = join(dir, "one", "two")
  const file = join(targetDir, "value.json")
  assert.equal(writeJson(file, { ok: true }), true)
  assert.deepEqual(readJson(file), { ok: true })

  if (process.platform !== "win32") {
    assert.equal(statSync(targetDir).mode & 0o777, 0o700)
    assert.equal(statSync(file).mode & 0o777, 0o600)
  }
})

test("calendar：同一时刻按 Asia/Shanghai 与 America/New_York 跨日", () => {
  const now = new Date("2026-01-01T16:30:00.000Z")
  assert.deepEqual(calendar(now, "Asia/Shanghai"), {
    day: "2026-01-02",
    time: "00:30",
    hour: 0,
  })
  assert.deepEqual(calendar(now, "America/New_York"), {
    day: "2026-01-01",
    time: "11:30",
    hour: 11,
  })
})

test("calendar：午夜使用 00 而不是 24", () => {
  assert.deepEqual(calendar(new Date("2026-06-01T16:00:00.000Z"), "Asia/Shanghai"), {
    day: "2026-06-02",
    time: "00:00",
    hour: 0,
  })
})

test("calendar：非法时区明确抛出 RangeError", () => {
  assert.throws(() => calendar(new Date(), "Not/A_TimeZone"), RangeError)
})
