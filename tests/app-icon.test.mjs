// tests/app-icon.test.mjs —— 从客户端 exe 里取图标的解析器
//
// 这里测的是「认不认得出来」，不是「厂商的包长什么样」——
// 真实的安装包（WorkBuddy 5.9.3 的 exe）实测过：资源树拿到 16/20/24/28/32/40/
// 48/64/96/128/256 十一档，256 那档的 sha256 与手工提取的一致。

import test from "node:test"
import assert from "node:assert/strict"

import { peSections, findIconsBySignature, iconPngs } from "../scripts/app-icon.mjs"

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// fakePng 造一个够解析的 PNG 外壳：签名 + IHDR(宽高) + 填充 + IEND
function fakePng(width, height = width, pad = 8) {
  const buf = Buffer.alloc(24 + pad + 8)
  SIG.copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write("IHDR", 12, "latin1")
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf.write("IEND", 24 + pad, "latin1")
  return buf
}

test("找得出多档 PNG，宽高不同、超范围的不算", () => {
  const blob = Buffer.concat([
    Buffer.alloc(32),
    fakePng(32),
    Buffer.alloc(16),
    fakePng(256),
    Buffer.alloc(16),
    fakePng(64, 32), // 非方形
    Buffer.alloc(16),
    fakePng(2048), // 超范围
  ])
  const found = findIconsBySignature(blob)
  assert.deepEqual(found.map((i) => i.width).sort((a, b) => a - b), [32, 256])
})

test("不是 PE 的输入不抛，只是返回 null", () => {
  assert.equal(peSections(Buffer.from("not a pe file at all")), null)
  const mz = Buffer.alloc(0x40)
  mz[0] = 0x4d
  mz[1] = 0x5a
  assert.equal(peSections(mz), null, "有 MZ 但没有 PE 头")
})

test("没有 .rsrc 段时资源树解析返回空，调用方回退签名扫描", () => {
  const sections = [{ name: ".text", vsize: 0x100, vaddr: 0x1000, rsize: 0x100, raddr: 0x400 }]
  assert.deepEqual(iconPngs(fakePng(256), sections), [])
  assert.deepEqual(iconPngs(fakePng(256), null), [])
})

test("段表被截断时按已读到的算，不越界读", () => {
  // 造一个 PE 头：MZ + e_lfanew 指向 PE 签名 + 声明 2 个段，但只给 1 个半
  const buf = Buffer.alloc(0x120)
  buf[0] = 0x4d
  buf[1] = 0x5a
  buf.writeUInt32LE(0x40, 0x3c)
  buf.write("PE\0\0", 0x40, "latin1")
  buf.writeUInt16LE(2, 0x40 + 4 + 2) // NumberOfSections
  buf.writeUInt16LE(224, 0x40 + 4 + 16) // SizeOfOptionalHeader
  buf.writeUInt16LE(0x10b, 0x40 + 4 + 20) // magic = PE32
  const table = 0x40 + 4 + 20 + 224
  if (table + 40 <= buf.length) buf.write(".rsrc", table, "latin1")
  const sections = peSections(buf)
  assert.ok(Array.isArray(sections), "PE 头认得出来")
  assert.ok(!sections.some((s) => s.name === ".rsrc" && s.raddr), "没写全的段不该被当成可用段")
})
