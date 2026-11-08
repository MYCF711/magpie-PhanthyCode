#!/usr/bin/env node
// app-icon.mjs —— 从厂商的桌面客户端里取「官方应用图标」，做成 magpie 要的 data URI
//
// 为什么需要它：
//
//   官网的 favicon 通常是「品牌徽标」，不一定是「应用图标」。WorkBuddy 就是这样：
//   三个域名（www.workbuddy.cn / download.codebuddy.cn / www.workbuddy.ai）的
//   favicon 都是同一份 logo.svg，而它里面是 `<rect rx="20">` —— 40 宽画布上
//   rx=20 就是正圆。magpie 把每个 provider 的图标画在**圆角方框**里，圆形放进去
//   四角全空，卡片上看起来就是「方块里套了个圆」，和旁边别的插件不齐。
//
//   真正的应用图标（圆角方形那枚）在客户端安装包里：Windows 的 exe 把图标存成
//   PE 资源段的 RT_ICON（type 3），新一点的打包器直接放多档 PNG
//   （16 / 20 / 24 / 32 / 40 / 48 / 64 / 96 / 128 / 256）。256 那档拖出来就是
//   官方原图 —— 比站点 favicon 适合当卡片图标，也比自己画一个诚实。
//
//   一个坑：**不能只按 PNG 签名扫**。安装包里的界面插图、二维码也是 PNG，
//   扫出来最大那张往往是个插图。所以要真的走一遍 PE 资源树，只要 RT_ICON。
//
// 用法：
//   node scripts/app-icon.mjs <installer.exe | app.exe>            # 列出所有尺寸
//   node scripts/app-icon.mjs <exe> --out icon.png                # 存最大的那档
//   node scripts/app-icon.mjs <exe> --data-uri                    # 打印 data URI
//   node scripts/app-icon.mjs <exe> --size 256 --out icon.png     # 指定尺寸
//
// 退出码：0 = 拿到图标；1 = 文件读不到；2 = 里面没有 PNG 图标（老式 BMP 图标）

import { openSync, readSync, closeSync, writeFileSync, statSync } from "node:fs"
import { basename } from "node:path"

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const RT_ICON = 3
// 图标资源在 .rsrc 里，安装包常见几 MB 到十几 MB 处；整包 450 MB 没必要全读。
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

function usage() {
  console.error(`app-icon.mjs —— 从客户端可执行文件里取官方应用图标

  node scripts/app-icon.mjs <exe> [选项]

  --out <file>     把选中的那档存成 PNG
  --data-uri       打印 data:image/png;base64,…（magpie 的 icon 字段直接可用）
  --size <px>      指定尺寸（默认取最大的一档）
  --max-bytes <n>  只读文件前 n 字节（默认 64 MiB）
  --full           读完整个文件（图标在很靠后的位置时用）
`)
}

function parseArgs(argv) {
  const opts = { exe: null, out: null, dataUri: false, size: 0, maxBytes: DEFAULT_MAX_BYTES }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === "--out") opts.out = argv[++i]
    else if (a === "--data-uri") opts.dataUri = true
    else if (a === "--size") opts.size = Number(argv[++i])
    else if (a === "--max-bytes") opts.maxBytes = Number(argv[++i])
    else if (a === "--full") opts.maxBytes = Infinity
    else if (a === "-h" || a === "--help") {
      usage()
      process.exit(0)
    } else if (!a.startsWith("-")) opts.exe = a
    else {
      console.error(`不认识的参数：${a}`)
      usage()
      process.exit(1)
    }
  }
  if (!opts.exe) {
    usage()
    process.exit(1)
  }
  if (opts.size && (!Number.isInteger(opts.size) || opts.size < 16 || opts.size > 1024)) {
    console.error("--size 要在 16~1024 之间")
    process.exit(1)
  }
  return opts
}

/**
 * peSections 读出 PE 的段表（只认 32/64 位 exe）。
 * 不是 PE（脚本、zip、dmg 里的 Mach-O）返回 null，调用方走兜底。
 */
export function peSections(buf) {
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null
  const peOff = buf.readUInt32LE(0x3c)
  if (peOff + 24 > buf.length || buf.toString("latin1", peOff, peOff + 4) !== "PE\0\0") return null
  const coff = peOff + 4
  const nsec = buf.readUInt16LE(coff + 2)
  const optSize = buf.readUInt16LE(coff + 16)
  const opt = coff + 20
  const magic = buf.readUInt16LE(opt)
  if (magic !== 0x10b && magic !== 0x20b) return null
  const table = opt + optSize
  const sections = []
  for (let i = 0; i < nsec; i += 1) {
    const off = table + i * 40
    if (off + 40 > buf.length) break
    sections.push({
      name: buf.toString("latin1", off, off + 8).replace(/\0+$/, ""),
      vsize: buf.readUInt32LE(off + 8),
      vaddr: buf.readUInt32LE(off + 12),
      rsize: buf.readUInt32LE(off + 16),
      raddr: buf.readUInt32LE(off + 20),
    })
  }
  return sections
}

// iconPngs 走一遍 .rsrc 的资源树，只取 RT_ICON 的叶子，且只认 PNG 编码的。
export function iconPngs(buf, sections) {
  const rsrc = sections?.find((s) => s.name === ".rsrc")
  if (!rsrc || !rsrc.raddr || !rsrc.rsize) return []
  const base = rsrc.raddr
  const toFile = (rva) => rva - rsrc.vaddr + rsrc.raddr
  const out = []

  const walk = (dirOff, level, typeId) => {
    if (dirOff + 16 > buf.length) return
    const named = buf.readUInt16LE(dirOff + 12)
    const ids = buf.readUInt16LE(dirOff + 14)
    for (let i = 0; i < named + ids; i += 1) {
      const ent = dirOff + 16 + i * 8
      if (ent + 8 > buf.length) return
      const nameField = buf.readUInt32LE(ent)
      const offField = buf.readUInt32LE(ent + 4)
      const isDir = (offField & 0x80000000) !== 0
      const child = offField & 0x7fffffff
      const id = (nameField & 0x80000000) !== 0 ? null : nameField
      const curType = level === 0 ? id : typeId
      if (isDir) {
        if (level < 3) walk(base + child, level + 1, curType)
        continue
      }
      if (curType !== RT_ICON) continue
      const dataEnt = base + child
      if (dataEnt + 16 > buf.length) continue
      const rva = buf.readUInt32LE(dataEnt)
      const size = buf.readUInt32LE(dataEnt + 4)
      const fileOff = toFile(rva)
      if (size < 24 || fileOff < 0 || fileOff + size > buf.length) continue
      const png = buf.subarray(fileOff, fileOff + size)
      if (!png.subarray(0, 8).equals(PNG_SIG)) continue // BMP 编码的老图标：不处理
      const width = png.readUInt32BE(16)
      const height = png.readUInt32BE(20)
      if (width !== height || width < 16 || width > 1024) continue
      out.push({ width, height, start: fileOff, end: fileOff + size })
    }
  }

  walk(base, 0, null)
  return out
}

// findIconsBySignature 是兜底：资源树读不出来时按 PNG 签名扫。
// 它会混进界面插图，所以只在资源树为空时才用。
export function findIconsBySignature(buf) {
  const found = []
  let at = 0
  while (true) {
    at = buf.indexOf(PNG_SIG, at)
    if (at < 0) break
    if (at + 24 <= buf.length && buf.toString("latin1", at + 12, at + 16) === "IHDR") {
      const width = buf.readUInt32BE(at + 16)
      const height = buf.readUInt32BE(at + 20)
      const end = buf.indexOf(Buffer.from("IEND"), at)
      if (width >= 16 && width <= 1024 && width === height && end > 0) {
        found.push({ width, height, start: at, end: end + 8 })
      }
    }
    at += PNG_SIG.length
  }
  return found
}

function readHead(exe, maxBytes) {
  const size = statSync(exe).size
  const want = Number.isFinite(maxBytes) ? Math.min(size, maxBytes) : size
  const fd = openSync(exe, "r")
  try {
    const buf = Buffer.alloc(want)
    const got = readSync(fd, buf, 0, want, 0)
    return buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

function dedupe(icons) {
  const bySize = new Map()
  for (const icon of icons) if (!bySize.has(icon.width)) bySize.set(icon.width, icon)
  return [...bySize.values()].sort((a, b) => a.width - b.width)
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  let buf
  try {
    buf = readHead(opts.exe, opts.maxBytes)
  } catch (e) {
    console.error(`读不到 ${opts.exe}：${e.message}`)
    process.exit(1)
  }

  let icons = []
  let source = "资源树 RT_ICON"
  const sections = peSections(buf)
  if (sections) icons = dedupe(iconPngs(buf, sections))
  if (!icons.length) {
    icons = dedupe(findIconsBySignature(buf))
    source = "按 PNG 签名扫（可能混进界面插图，核对一下）"
  }
  if (!icons.length) {
    console.error(`${basename(opts.exe)} 里没找到 PNG 图标 —— 老式 BMP 图标，或图标在 ${opts.maxBytes} 字节之后`)
    console.error("试一下 --full；还是空的话这个客户端用的是 BMP 图标，本脚本不处理")
    process.exit(2)
  }

  const picked = opts.size ? icons.find((i) => i.width === opts.size) : icons[icons.length - 1]
  if (!picked) {
    console.error(`没有 ${opts.size}px 这一档；有：${icons.map((i) => i.width).join(" / ")}`)
    process.exit(2)
  }

  const png = buf.subarray(picked.start, picked.end)
  if (!opts.out && !opts.dataUri) {
    console.log(`${basename(opts.exe)} 里的图标：${icons.map((i) => `${i.width}px`).join(" / ")}`)
    console.log(`来源：${source}`)
    console.log(`\n选中最大的一档：${picked.width}×${picked.height}，${png.length} 字节（偏移 ${picked.start}）`)
    console.log("加 --out icon.png 存文件，或 --data-uri 直接打印 data URI")
    return
  }
  if (opts.out) {
    writeFileSync(opts.out, png)
    console.error(`已写入 ${opts.out}（${picked.width}×${picked.height}，${png.length} 字节）`)
  }
  if (opts.dataUri) console.log(`data:image/png;base64,${png.toString("base64")}`)
}

if (process.argv[1]?.endsWith("app-icon.mjs")) main()
