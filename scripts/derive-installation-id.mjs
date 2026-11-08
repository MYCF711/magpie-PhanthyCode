#!/usr/bin/env node
// scripts/derive-installation-id.mjs —— 离线派生 / 反查 installationId
//
// 官方算法已于 2026-11-09 真机实测确认（见 src/installation-id.mjs 文件头）：
//   installationId = "di_" + base64url(sha256(SPKI_DER[12:]))
// 这个脚本不发任何请求：
//
//   给一把公钥 → 直接算出官方 installationId（也可列出全部候选做对照）；
//   拿到真实 installationId → `--match` 直接判定是哪条规则。
//
// 用法：
//   node scripts/derive-installation-id.mjs --public-key <SPKI base64url>
//   node scripts/derive-installation-id.mjs --public-key <...> --match <真实值>
//   node scripts/derive-installation-id.mjs --generate
//   node scripts/derive-installation-id.mjs --scope <account.uuid>   # ⚠ 旧公式，只做对照
//
// ⚠ `--scope` 是**已被否证**的公式（哈希的是 accountScope，官方哈希公钥），保留只为
//   跟旧记录对照；它算出来的值服务端永远不认。

import { createHash, randomUUID } from "node:crypto"

import {
  OFFICIAL_RULE,
  RULES,
  candidatesFor,
  installationIdFromPublicKey,
  installationIdFromScope,
  matchRule,
} from "../src/installation-id.mjs"
import { generateEd25519KeyPair, importPublicKey } from "../src/proof.mjs"

function parseArgs(argv) {
  const out = { publicKey: "", match: "", generate: false, json: false, scope: "", expect: "" }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === "--public-key") {
      out.publicKey = String(argv[i + 1] ?? "")
      i += 1
    } else if (key === "--match") {
      out.match = String(argv[i + 1] ?? "")
      i += 1
    } else if (key === "--generate") {
      out.generate = true
    } else if (key === "--scope") {
      out.scope = String(argv[i + 1] ?? "")
      i += 1
    } else if (key === "--expect") {
      out.expect = String(argv[i + 1] ?? "")
      i += 1
    } else if (key === "--json") {
      out.json = true
    } else if (key === "--help" || key === "-h") {
      out.help = true
    } else {
      out.unknown = key
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(
    [
      "node scripts/derive-installation-id.mjs --public-key <SPKI base64url> [--match <真实 installationId>]",
      "node scripts/derive-installation-id.mjs --generate",
      "node scripts/derive-installation-id.mjs --scope <account.uuid> [--expect <官方观测到的 installationId>]",
      "",
      `候选规则：${Object.keys(RULES).length} 条；只做离线派生与比对，不发任何请求。`,
    ].join("\n"),
  )
  process.exit(0)
}
if (args.unknown) {
  console.error(`✖ 未知参数：${args.unknown}`)
  process.exit(2)
}

// @deprecated 旧公式：哈希的是 accountScope（官方哈希公钥）。只做对照，服务端永远不认。
if (args.scope) {
  const id = installationIdFromScope(args.scope)
  console.log(`\n规则（已废弃）：${"base64url(sha256(accountScope))"}\n派生值：${id}\n长度：${id.length}`)
  if (args.expect) {
    const ok = id === args.expect
    console.log(ok ? "✓ 与观测值一致" : `✗ 不一致（观测值：${String(args.expect).slice(0, 12)}…）`)
    process.exit(ok ? 0 : 1)
  }
  process.exit(0)
}

let publicKey = args.publicKey
if (args.generate || !publicKey) {
  const pair = generateEd25519KeyPair()
  publicKey = pair.publicKeyB64Url
  if (args.generate) console.log(`\n样例公钥（新生成，非真实设备）：${publicKey}\n`)
}

try {
  importPublicKey(publicKey)
} catch {
  console.error("✖ 这不是一个合法的 SPKI/base64url 公钥")
  process.exit(2)
}

const rows = candidatesFor(publicKey)
const official = installationIdFromPublicKey(publicKey)

if (args.match) {
  const rule = matchRule(publicKey, args.match)
  if (rule) {
    console.log(`\n✓ 命中：${rule}\n  官方值：${args.match}\n`)
    process.exit(0)
  }
  console.log(`\n✗ 未命中（共试了 ${rows.length} 种候选）。需要从二进制里再确认算法，别拿注册次数试。\n`)
  console.log(`随机对照：${randomUUID()}（仅说明格式，不代表任何规则）\n`)
  process.exit(1)
}

if (args.json) {
  console.log(JSON.stringify({ publicKey, rule: OFFICIAL_RULE, installationId: official, candidates: rows }, null, 2))
} else {
  console.log(`\n公钥：${publicKey}`)
  console.log(`\n官方 installationId：${official}`)
  console.log(`\n全部候选（${rows.length} 条，带 di_ 前缀）：`)
  for (const row of rows) console.log(`  ${row.rule}\n    ${row.id}`)
  console.log("\n拿到真实 installationId 后：--match <值>，命中的那条就是要实现的规则。\n")
}
