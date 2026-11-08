# PROTOCOL-INFERENCE.md —— 推理面请求的完整规格（从安装包实证）

> 来源：`claude-sidecar.exe`（Bun 单文件，内嵌完整 JS 源码）与 `PhanthyWork.exe`（Tauri Rust）。
> 取证方式：字符串定位 + 上下文反编译（`scripts/dump-sidecar-ctx.mjs`），**未运行任何 exe**。
> 对应实现：`fetch` 桥 `bd3`、证明头 `rw8`、令牌校验 `lw8`。
> 首次写成：2026-11-09。凡本文件与代码冲突，以本文件列出的二进制证据为准，并同步修代码。

---

## 一、推理端点只有三个

```js
Pd3 = new Set(["/v1/messages", "/v1/responses", "/v1/chat/completions"])
```

| 路径 | 协议 | 用途 |
|---|---|---|
| `/v1/messages` | Anthropic Messages | 主聊天通道 |
| `/v1/responses` | OpenAI Responses | 兼容通道 |
| `/v1/chat/completions` | OpenAI Chat Completions | 兼容通道 |

入口条件（`bd3`，不满足直接 404，**不是** 401）：

```js
method === "POST"
&& Pd3.has(pathname)
&& (search === "" || (pathname === "/v1/messages" && search === "?beta=true"))
```

`Authorization` 必须是 `Bearer <非空>`（`/^Bearer .+$/i`），否则 **401**。

请求体上限 `Gd3 = 16777216`（16 MiB），超了 **413**。

---

## 二、请求头：转发前做的三件事

客户端发到本地桥的头，转发到云端前按顺序处理：

```js
// ① x-phanthy-session 展开成三件套
if (headers.has("x-phanthy-session")) {
  headers.set("x-claude-code-session-id", x-phanthy-session)
  headers.delete("x-phanthy-expert-id")
  headers.delete("x-phanthy-skill-names")
  const meta = L$7.get(x-phanthy-session)      // 会话元数据表
  if (meta?.expertId)        headers.set("x-phanthy-expert-id", meta.expertId)
  if (meta?.skillNames?.length) headers.set("x-phanthy-skill-names", meta.skillNames.join(","))
}

// ② 删掉不该透传的
for (const k of ["host","connection","content-length","transfer-encoding",
                 "x-phanthy-desktop-session","x-phanthy-proof-signature",
                 "x-phanthy-proof-nonce","x-phanthy-proof-timestamp"]) {
  headers.delete(k)
}

// ③ 重新生成四个证明头
Object.assign(headers, rw8(method, pathname, rawBody, headers))
```

**要点**：证明头由桥**重新生成**，客户端自己带的一律删掉再覆盖。

---

## 三、四个证明头（`rw8`）

```js
{
  "x-phanthy-desktop-session": "<desktop_inference_token 原值>",
  "x-phanthy-proof-timestamp": String(Math.round(now - clockSkewMs)),
  "x-phanthy-proof-nonce":     base64url(24 字节随机),
  "x-phanthy-proof-signature": ed25519_sign(inference_privateKey, canonical).base64url
}
```

⚠ `x-phanthy-desktop-session` 放的是**推理令牌本身**，不是任何 sessionId。
（插件当前实现写的是 `installation.sessionId`，是错的。）

签名私钥是**推理密钥**（即 `inference_public_key` 对应的私钥），不是 identity、也不是 device。

---

## 四、canonical：12 段，LF 连接

```
desktop-inference-v2
<METHOD 大写>
<pathname>
<timestamp>
<nonce>
base64url(sha256(rawBody))
base64url(sha256(authorization 头的完整值))
base64url(sha256(desktop_inference_token))
<x-request-id 或 "">
<x-claude-code-session-id 或 "">
<x-phanthy-expert-id 或 "">
<x-phanthy-skill-names 或 "">
```

规则：
- 分隔符是 **LF（0x0A）**，不是 `:`、不是 `|`
- 第 6 段哈希的是**最终发出的 body 原始字节**（不是重新序列化的 JSON）
- 第 7 段哈希的是 `Authorization` 头的**完整值**，包含 `Bearer ` 前缀
- 后 4 段缺项写**空串**，但分隔符不能省 —— 少一段就变成另一个串
- method 在这条串里是**大写**（v1 那条保持原值）

---

## 五、body：逐字节透传

桥把 body 读成 `Buffer` 后**原样转发**，不解析、不重排、不补字段。
所以 canonical 第 6 段能对上 —— 任何"顺手 JSON.stringify 一下"都会破坏签名。

三家的 body 形状（来自桥自带的自检函数）：

```jsonc
// /v1/messages（Anthropic）
{
  "model": "<model id>",
  "max_tokens": 16,
  "stream": true,
  "system": "...",                 // 可选
  "messages": [{ "role": "user", "content": "..." }],
  "tools": [ /* Anthropic 工具 schema */ ]
}

// /v1/chat/completions（OpenAI Chat）
{ "model": "...", "max_tokens": 16, "messages": [{ "role": "user", "content": "..." }] }

// /v1/responses（OpenAI Responses）
{ "model": "...", "max_output_tokens": 16,
  "input": [{ "type": "message", "role": "user", "content": "..." }] }
```

---

## 六、令牌校验（`lw8`）

`desktop_inference_token` 是 JWT，桥在发请求前自检：

```js
payload.proof_version === 2
payload.inference_public_key === currentSessionPublicKey   // 否则 key_mismatch
typeof payload.exp === "number" && payload.exp > 0
payload.exp * 1000 > now                                    // 允许 up3 = 300000ms 时钟偏移
```

`inference_public_key` 每次 sidecar 启动重新生成（`M44 = generateKeyPairSync("ed25519")`），
所以重启后新令牌必须重新向 `activities/summary` 换一次。

---

## 七、失败处理

| 上游返回 | 桥的动作 |
|---|---|
| `401` | 刷新 OAuth token 后重试一次（20 秒窗口内，`Nd3 = 20000`） |
| `403` 且 body 里 `error.code === "request_not_authorized"` | 刷新推理令牌后重试，最多 `Ad3 = 2` 次 |
| `3xx` | 转成 502 `upstream_unavailable` |
| 网络异常 | 502 `upstream_unavailable` |

`request_not_authorized` 是「推理令牌过期/不匹配」的信号，不是登录问题 —— 见到它就换令牌重试。

---

## 八、和 `installationId` 的关系

`installationId` 只用于**注册/签名层**（`x-desktop-installation-id`），推理请求**不**带它。
推理只认推理令牌 + 推理密钥签名。

`installationId = "di_" + base64url(sha256(SPKI_DER 的裸 32 字节公钥))`，实测验证见
`scripts/probe-e2e.mjs` 与 `scripts/brute-rawkey.mjs`。

---

## 九、复现证据

### 9.1 Rust 主程序（`PhanthyWork.exe`，反汇编）—— installationId 公式

| 地址 | 结论 |
|---|---|
| `0x1400554A0` | `sha256(32 字节) → base64url` 的**唯一实现** |
| `0x1403CA1CD` | 该函数的**唯一调用点**（全二进制只有 1 处 ⇒ 没有第二条派生分支） |

调用点入参：`SPKI_DER` 指针 `+12`、长度 `32` —— 即丢掉 12 字节固定头
`302a300506032b6570032100` 后的**裸 ed25519 公钥**；返回值再拼 `di_` 前缀。
只有 `public_key`（identity）走这条；用 `device_public_key` / `inference_public_key`
派生出来的 id 服务端都不认。

### 9.2 sidecar（`claude-sidecar.exe`，Bun 单文件）—— 推理桥

关键偏移：`desktop-inference-v2` @ `0x5f46a35`；`bd3` 桥 @ `0x5f53719`；
`Pd3` 常量表 @ `0x5f53efc`。

### 9.3 device canonical 的段序（逐字节核对，别写错）

```
desktop-device-v1
<accountScope>
<installationId>
<public_key>              ← identity 公钥
<inference_public_key>    ← ⚠ 第 5 段是**推理公钥**，不是 public_key 重复
<timestamp>
<nonce>
```

`src/proof.mjs` 的 `deviceCanonical` 段序与之逐段对应；`src/production-auth.mjs`
传的是 `sessionKeyPublicKey: record.inferencePublicKey`（早期传过 `record.publicKey`，
签名必然对不上）。

### 9.4 只读工具（**不进 npm 包**）

`package.json` 的 `files` 白名单**不含 `scripts/`**，所以下面这些调试脚本不会被发布：

```bash
# 定位任意字符串的上下文（只读，不执行 exe）
node scripts/dump-sidecar-ctx.mjs "/v1/messages" 700 1200 2
node scripts/dump-sidecar-ctx.mjs "desktop-inference-v2" 200 3000 3
node scripts/dump-sidecar-ctx.mjs "rw8(" 1500 1800 4
node scripts/dump-sidecar-ctx.mjs "Pd3=" 300 900 3
node scripts/dump-bin-ctx.mjs <exe> <字符串> ...

# 中间人抓包（临时 CA + 代理；用完必须清理，见任务边界）
node scripts/mitm-capture.mjs [port] [logfile]
node scripts/dump-capture.mjs [capture.jsonl]

# 端到端验证（自建三把密钥 → 注册 → 推理；需要本机未过期的 access token）
node scripts/detect-local-login.mjs
node scripts/probe-e2e.mjs
```

### 9.5 真机验收记录（2026-11-09，真实账号）

凭据：`%USERPROFILE%\.phanthy-code\.credentials.json`，`cloud_access` 可导入
（token 值、长度、指纹一律不落文档，见 AGENTS §8.2）；设备
`installationId = di_MQzXlLs6…`（脱敏；三把公钥互异）。

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| ① | 从本机导入是否不再弹输入框 | **通过** | `auth.methods[1] = { type:"api", label:"从本机导入 PhanthyCode 登录", keyless:true }`，`"placeholder" in m === false` |
| ② | 每日签到返回什么 | **通过（但语义应是 done）** | `{ "outcome": "claimed", "message": "今日已签到" }` —— 不是 `failed`，判据满足；但服务端 200 + 文案「今日已签到」+ 本次 `credit=0`，按 HOOKS 二应为 `done`（见 §9.6 待修项） |
| ③ | 用量面板 | **通过** | `windows` = 5 条：`5 小时` / `7 天` / `套餐额度` / `积分` / `套餐`；`used` 为有限数字（0 / 0.04）；`resetsAt`、`until` 均为 ISO（`2026-12-08T12:34:16.243Z`）；`plan="体验版"` |
| ④ | 模型条数 + 真实推理 | **通过** | 目录 **13 条**（`deepseek-v4.1-flash-1017`、`glm-5.2`、`glm-5.3`、`glm-5.3-flash`、`kimi-k2.7-code`、`kimi-k3`、`Phana-5.5o`、`Phana-5.5s`、`Phano-6.1s`、`Phano-6a`、`Phanthy-fast`、`Phanthy-pro`、`Phanthy-ultra`）；`POST /v1/messages` → **HTTP 200**，`content[0].type="thinking"` 有正文，`usage.output_tokens=32`（`stop_reason=max_tokens`） |

复现命令（拿到有效 token 后）：

```bash
node scripts/detect-local-login.mjs
PHANTHY_ALLOW_DEVICE_REGISTER=1 PHANTHY_ALLOW_CHECKIN=1 node scripts/probe-live.mjs all
node scripts/probe-endpoints.mjs all
```

### 9.6 待修项（真机四问暴露）

1. **签到 `claimed` / `done` 判定**：`src/activity.mjs` 的 `claim()` 只要 POST 回 200/201 就返回
   `claimed`，即使 `reconcileCheckin` 的差集是 0、上游文案是「今日已签到」。应按「本次是否真的
   新增了 `daily_login` 奖励」判 `done`（与 `dailyLoginGranted` 的口径一致），否则用户看到
   `claimed` 但积分没变。
2. **静态兜底模型 id 大小写**：静态表是 `phanthy-fast`（小写，`src/context.mjs`），真实目录是
   `Phanthy-fast`（大写）。未登录时选的模型在登录后 id 对不上，需要在 `assignSlugs` 或静态表里统一。

### 9.7 抓包现场清理（已完成）

- `scripts/mitm-capture.mjs` 的代理进程（PID 37260，`127.0.0.1:18899`）已 kill，端口已释放；
- 临时 CA 与叶子证书（`D:\AI\tmp\pw-mitm\` 下 `ca.key` / `ca.crt` / `certs\*.key|crt`）与
  `capture.jsonl` 已删除；
- 系统代理未残留：`netsh winhttp show proxy` = Direct；WinINET 的 `127.0.0.1:7890` 是用户自己的
  代理，**未改动**；`HTTP_PROXY` / `HTTPS_PROXY` / `NODE_EXTRA_CA_CERTS` 均为空。


