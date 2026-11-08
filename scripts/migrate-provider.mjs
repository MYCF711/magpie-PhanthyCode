// scripts/migrate-provider.mjs —— 一次性：把 magpie 配置里的旧 provider id 迁到新 id
//
// 背景：0.1.0 把 provider id 从 `phanthy` 改成 `phanthycode`。
// magpie 的三份配置里仍挂着旧 id，不迁的话用户看到的是「未登录 / 未签到 / 自动签到关」。
//
// ⚠ 只改**插件自己的条目**，其它 provider 一个字不动。改前自动备份。

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CONFIG = join(homedir(), ".config", "magpie")
const OLD = "phanthy"
const NEW = "phanthycode"
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)

function backup(file) {
  const bak = `${file}.bak-migrate-${stamp}`
  copyFileSync(file, bak)
  console.log(`  备份: ${bak}`)
}

function load(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    console.error(`  ✗ 解析失败 ${file}: ${error.message}`)
    return null
  }
}

function save(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2))
}

// ① plugin-auth.json —— 登录态
{
  const file = join(CONFIG, "plugin-auth.json")
  const json = load(file)
  if (json) {
    if (json[OLD] && !json[NEW]) {
      backup(file)
      json[NEW] = json[OLD]
      delete json[OLD]
      save(file, json)
      console.log(`  ✓ plugin-auth.json: ${OLD} → ${NEW}`)
    } else if (json[NEW]) {
      console.log(`  - plugin-auth.json: 已经是 ${NEW}（旧键${json[OLD] ? "另有残留" : "不存在"}）`)
      if (json[OLD]) {
        backup(file)
        delete json[OLD]
        save(file, json)
        console.log(`    删掉残留的 ${OLD}`)
      }
    } else {
      console.log(`  - plugin-auth.json: 没有 ${OLD}，跳过`)
    }
  }
}

// ② plugin-checkin.json —— 签到记录（键是 `provider|account`）
{
  const file = join(CONFIG, "plugin-checkin.json")
  const json = load(file)
  if (json) {
    const keys = Object.keys(json).filter((k) => k.startsWith(`${OLD}|`))
    if (keys.length > 0) {
      backup(file)
      for (const key of keys) {
        json[`${NEW}|${key.slice(OLD.length + 1)}`] = json[key]
        delete json[key]
      }
      save(file, json)
      console.log(`  ✓ plugin-checkin.json: 迁移 ${keys.length} 条`)
    } else {
      console.log(`  - plugin-checkin.json: 没有 ${OLD}| 开头的键，跳过`)
    }
  }
}

// ③ settings.json —— pluginCheckins 开关
{
  const file = join(CONFIG, "settings.json")
  const json = load(file)
  if (json) {
    const checkins = json.pluginCheckins ?? {}
    if (Object.prototype.hasOwnProperty.call(checkins, OLD)) {
      backup(file)
      if (!Object.prototype.hasOwnProperty.call(checkins, NEW)) checkins[NEW] = checkins[OLD]
      delete checkins[OLD]
      json.pluginCheckins = checkins
      save(file, json)
      console.log(`  ✓ settings.json: pluginCheckins.${OLD} → ${NEW}`)
    } else {
      console.log(`  - settings.json: pluginCheckins 没有 ${OLD}，跳过`)
    }
  }
}

console.log("")
console.log("完成。重启 magpie 生效：")
console.log("  Get-Process magpie,magpie-bun -EA SilentlyContinue | Stop-Process -Force")
console.log("  start $env:LOCALAPPDATA\\Programs\\magpie\\magpie.exe tray")
