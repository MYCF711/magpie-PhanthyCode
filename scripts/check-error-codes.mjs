#!/usr/bin/env node
// 静态近似检查：插件的错误出口是否都带 status + code，且 code 在 ERROR-CODES.md §3 词表里。
//
//   node scripts/check-error-codes.mjs [插件目录] [--json]
//
// 抓的是**形态**，不是语义；语义最终靠人工评审（见 ERROR-CODES.md §8 验收清单）。
// 但形态错了，语义基本也错：一个 404 用在「不支持的端点」上，宿主就会去换模型。
//
// 规则覆盖（与 ERROR-CODES.md §4 对齐）：
//   R1 每个 errorResponse 显式带 code
//   R2 code 只能取 §3 词表  ← 三种形态都要抓：`code: "…"`、`code = "…"`、`return "…"`（code 工厂）
//   R3 裸 throw new Error 的分布（提示，不判失败）
//   R4 404 只用于模型不存在
//   R5 非登录 401 必须带 `X-Magpie-Sign-In: kept`
//   R6 流式错误帧带 status
//   R7 message 不许是无信息量的空泛措辞
//   R8 超时类落 503/504
//   R9 词表里每个 code 至少有一条测试
//
// 词表来源：优先读 `<插件目录>/src/http.mjs` 的 `CODES`（唯一真源），
// 读不到才退回脚本内置的镜像 —— 三处词表手工同步正是审计 F3 的成因。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// §3 词表镜像（读不到 src/http.mjs 时用；加码要改 ERROR-CODES.md 并同步这里）
const FALLBACK_CODES = [
  "sign_in_required",
  "session_expired",
  "audit_blocked",
  "invalid_request",
  "model_not_found",
  "concurrency_conflict",
  "device_binding_conflict",
  "quota_exhausted",
  "plan_required",
  "rate_limited",
  "upstream_unavailable",
  "upstream_timeout",
  "upstream_error",
  "internal_error",
  "not_implemented",
];

/** 从 src/http.mjs 抽出 CODES 的取值（唯一真源） */
function readCodes(dir) {
  const file = path.join(dir, "src", "http.mjs");
  if (!fs.existsSync(file)) return { codes: FALLBACK_CODES, source: "内置镜像" };
  const src = fs.readFileSync(file, "utf8");
  const block = src.match(/export const CODES\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
  if (!block) return { codes: FALLBACK_CODES, source: "内置镜像（src/http.mjs 里没找到 CODES）" };
  const codes = [...block[1].matchAll(/(?:^|\s)([A-Za-z0-9_$]+)\s*:\s*"([a-z0-9_]+)"/g)].map((m) => m[2]);
  if (codes.length === 0) return { codes: FALLBACK_CODES, source: "内置镜像（CODES 为空）" };
  return { codes, source: "src/http.mjs 的 CODES" };
}

const MODELISH = /模型|model|ModelNotFound|reasoning|embedding/i;
const ENDPOINTISH = /端点|endpoint|不支持|unsupported|not_found|Not Found/i;
/** 无信息量的 message（R7）：单独出现等于什么都没说 */
const VAGUE_MESSAGE =
  /^(?:服务异常|系统异常|系统错误|出错了|未知错误|上游错误|请求失败|AI服务异常|error|failed|unknown error|oops)$/i;

/** 当前扫描用的词表（scanErrorCodes 每次按目标目录重读，见 readCodes） */
let CODES_SET = new Set(FALLBACK_CODES);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function targets(dir) {
  const out = [];
  const push = (p) => { if (fs.existsSync(p) && fs.statSync(p).isFile()) out.push(p); };
  push(path.join(dir, "index.mjs"));
  const src = path.join(dir, "src");
  if (fs.existsSync(src)) {
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".mjs")) out.push(p);
      }
    };
    walk(src);
  }
  return out;
}

/** 测试文件（R9 用）：tests/**\/*.test.mjs */
function testFiles(dir) {
  const out = [];
  const root = path.join(dir, "tests");
  if (!fs.existsSync(root)) return out;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".mjs")) out.push(p);
    }
  };
  walk(root);
  return out;
}

// 从左括号位置找到配对的右括号（跳过字符串）
function matchParen(src, openIdx) {
  let depth = 0;
  let quote = "";
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitArgs(src, openIdx, closeIdx) {
  const args = [];
  let depth = 0;
  let quote = "";
  let start = openIdx + 1;
  for (let i = openIdx + 1; i < closeIdx; i += 1) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = src.slice(start, closeIdx).trim();
  if (tail) args.push(tail);
  return args;
}

function lineOf(src, idx) {
  return src.slice(0, idx).split("\n").length;
}

/** 某个规则在这个文件里已经失败了几次（R1 的通过文案不能恒真） */
function failuresIn(results, rule) {
  return results.filter((r) => r.rule === rule && !r.ok).length;
}

function lineText(src, lineNo) {
  return (src.split("\n")[lineNo - 1] || "").trim();
}

function nearestFn(src, idx) {
  const before = src.slice(0, idx);
  const hits = [...before.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_$]+)|(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/g)];
  const last = hits[hits.length - 1];
  return last ? (last[1] || last[2]) : "(顶层)";
}

// 注释里的 404 / code 字样不算（「user/info 等全是 404」这种说明性文字）
function isCommentLine(src, idx) {
  const start = src.lastIndexOf("\n", idx) + 1;
  const line = src.slice(start, src.indexOf("\n", idx) === -1 ? src.length : src.indexOf("\n", idx)).trim();
  return line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");
}

function checkFile(file, src) {
  const results = [];
  const rel = path.basename(file);

  // ── R1 / R2：errorResponse 的 code 参数 ─────────────────────────────
  const calls = [...src.matchAll(/\berrorResponse\s*\(/g)];
  for (const m of calls) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    if (close < 0) continue;
    const args = splitArgs(src, open, close);
    const ln = lineOf(src, m.index);
    if (args.length < 3) {
      results.push({
        rule: "R1", ok: false, file: rel, line: ln,
        message: `errorResponse 没有显式 code 参数（默认落 upstream_error）`,
      });
      continue;
    }
    const codeArg = args[2];
    const lit = codeArg.match(/^["'`]([a-z0-9_]+)["'`]$/);
    if (lit) {
      if (!CODES_SET.has(lit[1])) {
        results.push({
          rule: "R2", ok: false, file: rel, line: ln,
          message: `code "${lit[1]}" 不在词表里`,
        });
      }
    }
    // ── R4：只有「错误出口上的 404」才检查 ──────────────────────────
    // 本地回调服务器 reply(404) 之类不是 magpie 的 chat 通道，不在此列。
    const whole = args.join(" ");
    const ctx = src.split("\n").slice(ln - 2, ln + 2).join(" ");
    if (/\b404\b/.test(whole) && ENDPOINTISH.test(ctx) && !MODELISH.test(ctx)) {
      results.push({
        rule: "R4", ok: false, file: rel, line: ln,
        message: `404 用在「不支持的端点」上 —— 会被宿主当成模型不存在，应改为 501 + not_implemented`,
      });
    }
  }
  if (calls.length && failuresIn(results, "R1") === 0) {
    results.push({ rule: "R1", ok: true, file: rel, line: 0, message: `errorResponse 调用 ${calls.length} 处，均带 code 参数` });
  }

  // ── R2：三种 code 形态（审计 F3：只认 `code: "…"` 时，`return "…"` 整类逃逸）──
  //   ① `code: "x"` / `code = "x"`（**必须**是 magpie 错误出口的上下文：
  //      `new ApiError(...)` / `errorResponse(...)` / 错误帧 `error: { ... }`；
  //      独立 Error 子类上的 `this.code = "…"` 不是宿主读的 code，不在此列）
  //   ② `return "x"`（code 工厂函数）
  //   ③ `new Set([...])`（词表白名单，且集合本身与 code 有关）
  const isMagpieCodeSite = (src, index) => {
    const ctx = src.slice(Math.max(0, index - 320), index);
    if (/\bthis\.code\s*[:=]\s*$/.test(ctx.slice(-24))) return false;
    return /new ApiError\s*\(|errorResponse\s*\(|error\s*:\s*\{/.test(ctx);
  };
  for (const m of src.matchAll(/\bcode\s*[:=]\s*["'`]([a-z0-9_]+)["'`]/g)) {
    if (isCommentLine(src, m.index)) continue;
    if (!isMagpieCodeSite(src, m.index)) continue;
    if (!CODES_SET.has(m[1])) {
      results.push({
        rule: "R2", ok: false, file: rel, line: lineOf(src, m.index),
        message: `code 字段/赋值里的 code "${m[1]}" 不在词表里 —— 要么改成词表内的，要么升级 ERROR-CODES.md §3`,
      });
    }
  }

  // ③ 词表白名单初始化：只认集合名或同段文字里出现 code 的那个
  for (const m of src.matchAll(/\bnew Set\s*\(\s*\[[^\]]{0,400}?\]/g)) {
    const block = m[0];
    if (!/code/i.test(block)) continue;
    for (const lit of block.matchAll(/["'`]([a-z0-9_]+)["'`]/g)) {
      if (!CODES_SET.has(lit[1])) {
        results.push({
          rule: "R2", ok: false, file: rel, line: lineOf(src, m.index),
          message: `code 白名单初始化里的 "${lit[1]}" 不在词表里`,
        });
      }
    }
  }

  // ② `return "x"`：只有所在函数是 code 工厂（名字带 code）才算 code，避免把
  //    普通字符串返回值（如遗留的 `return "quota_exhausted"`）误判成别的语义。
  for (const m of src.matchAll(/\breturn\s+["'`]([a-z0-9_]+)["'`]/g)) {
    if (isCommentLine(src, m.index)) continue;
    const fn = nearestFn(src, m.index);
    if (!/code/i.test(fn)) continue;
    if (!CODES_SET.has(m[1])) {
      results.push({
        rule: "R2", ok: false, file: rel, line: lineOf(src, m.index),
        message: `${fn}() 返回的 code "${m[1]}" 不在词表里（return 形态最容易被漏检）`,
      });
    }
  }

  // ── R5：非登录 401 必须带 `X-Magpie-Sign-In: kept` ─────────────────
  //  判定口径：这个文件里既出现 401 的分类，又是「把上游响应交给宿主」的出口
  //  （`return res`），就必须有一条 kept 分支。真正的错误出口在 src/http.mjs 的
  //  errorResponse（允许用 `signIn: "kept"`）。
  if (/\b401\b/.test(src) && /\breturn\s+res\b/.test(src) && !/x-magpie-sign-in/i.test(src)) {
    results.push({
      rule: "R5", ok: false, file: rel, line: lineOf(src, src.search(/\b401\b/)),
      message: "存在 401 透传分支但没有 `x-magpie-sign-in: kept` —— 上游对单个模型回 401 会停掉整个账号",
    });
  } else if (/x-magpie-sign-in/i.test(src)) {
    results.push({ rule: "R5", ok: true, file: rel, line: 0, message: "401/403 的非登录分支带 `x-magpie-sign-in: kept`" });
  }

  // ── R7：message 不许是无信息量的空泛措辞 ────────────────────────────
  for (const m of src.matchAll(/(?:errorResponse|new ApiError)\s*\(\s*(["'`])([\s\S]{0,80}?)\1/g)) {
    if (isCommentLine(src, m.index)) continue;
    const text = m[2].trim();
    if (VAGUE_MESSAGE.test(text)) {
      results.push({
        rule: "R7", ok: false, file: rel, line: lineOf(src, m.index),
        message: `message 是空泛措辞「${text}」—— 保留上游原文或写清真实原因`,
      });
    }
  }

  // ── R6：SSE 错误帧必须带 status ────────────────────────────────────
  for (const m of src.matchAll(/type\s*:\s*["'`]upstream_error["'`]/g)) {
    const window = src.slice(m.index, m.index + 260);
    if (!/\bstatus\b/.test(window)) {
      results.push({
        rule: "R6", ok: false, file: rel, line: lineOf(src, m.index),
        message: `流式错误帧缺 status 字段（宿主拿不到判据）`,
      });
    }
  }

  // ── R8：超时类不许落 502 ───────────────────────────────────────────
  for (const m of src.matchAll(/\b(?:timeout|idle|deadline|wallclock)\b/gi)) {
    const ln = lineOf(src, m.index);
    const ctx = src.split("\n").slice(ln - 1, ln + 2).join(" ");
    if (/\b502\b/.test(ctx)) {
      results.push({
        rule: "R8", ok: false, file: rel, line: ln,
        message: `超时类错误落到 502 —— 应落 503/504（可重试）`,
      });
    }
  }

  // ── R3 提示：裸 throw new Error 的分布 ─────────────────────────────
  const naked = [...src.matchAll(/throw\s+new\s+Error\s*\(/g)];
  if (naked.length) {
    const fns = [...new Set(naked.map((m) => nearestFn(src, m.index)))];
    results.push({
      rule: "R3", ok: true, file: rel, line: 0,
      message: `裸 throw new Error ${naked.length} 处，分布在：${fns.slice(0, 8).join("、")}${fns.length > 8 ? "…" : ""}（逐个确认是否进聊天通道；进了就必须包成 upstreamError(msg, status)）`,
    });
  }

  return results;
}

// 供 scripts/check.mjs 集成调用（同一个扫描，不重复实现）
export function scanErrorCodes(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = targets(dir);
  if (!files.length) return [];
  const { codes, source } = readCodes(dir);
  CODES_SET = new Set(codes);
  const all = [];
  for (const file of files) all.push(...checkFile(file, fs.readFileSync(file, "utf8")));

  // 规则覆盖必须可见（审计 F15：只在有命中时记录，输出里就只看得到 R1/R3，
  // 看起来像「其余规则不存在」）。没有命中的规则补一条「无命中」的通过记录。
  const RULE_LABEL = {
    R2: "code 全在词表内（code 字段 / return / 白名单三种形态）",
    R4: "404 没有用在「不支持的端点」上",
    R6: "没有自建 SSE 错误帧（透传上游流，规则不适用）",
    R7: "错误 message 没有空泛措辞",
    R8: "超时类没有落到 502",
  };
  for (const [rule, label] of Object.entries(RULE_LABEL)) {
    if (!all.some((r) => r.rule === rule)) {
      all.push({ rule, ok: true, file: "(全仓)", line: 0, message: label });
    }
  }

  // ── R9：词表里每个 code 至少有一条测试 ──────────────────────────────
  // 判据：该 code 的字符串字面量在 tests/ 里出现过（不要求特定断言形态，
  // 断言语义由测试本身负责）。`audit_blocked` 这类「有词表没产出」的项
  // 既往漏网（审计 F17），这里直接点名缺哪些。
  const tests = testFiles(dir);
  if (tests.length) {
    const blob = tests.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    const missing = codes.filter((code) => !blob.includes(`"${code}"`) && !blob.includes(`'${code}'`));
    all.push({
      rule: "R9",
      ok: missing.length === 0,
      file: "tests/",
      line: 0,
      message: missing.length === 0
        ? `词表 ${codes.length} 个 code 都有测试（词表来源：${source}）`
        : `这些 code 在 tests/ 里一条都没有：${missing.join(" / ")}`,
    });
  }
  return all;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const dir = args.find((a) => !a.startsWith("--")) || ".";
  if (!fs.existsSync(dir)) fail(`目录不存在：${dir}`);

  const files = targets(dir);
  if (!files.length) fail(`在 ${dir} 里没找到 index.mjs 或 src/**/*.mjs`);

  const all = scanErrorCodes(dir);

  if (asJson) {
    console.log(JSON.stringify(all, null, 2));
  } else {
    const bad = all.filter((r) => !r.ok);
    for (const r of all.filter((x) => x.ok)) console.log(`  ✓ ${r.rule} ${r.message}`);
    for (const r of bad) console.log(`  ✗ ${r.rule} ${r.file}:${r.line} ${r.message}`);
    const rules = new Set(all.map((r) => r.rule));
    console.log(`\n  扫描 ${files.length} 个文件 · 规则 ${[...rules].sort().join("/")} · 失败 ${bad.length}`);
    if (!bad.length) console.log("  通过：错误出口都带 status + code，且 code 在词表内。");
  }

  process.exit(all.some((r) => !r.ok) ? 1 : 0);
}
