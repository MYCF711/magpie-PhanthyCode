# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与规矩见 [UPDATING.md](./UPDATING.md)。

## 0.1.1 — 2026-11-09

**本地修复版：登录更省心、签到不再要求「先发一次模型请求」、价格未知的模型不再被当成免费。**
（只在本机验证；不推送、不发布。）

### 登录与设备身份

- **加号默认开一扇干净的浏览器**：OAuth 登录每次都用一份**一次性**浏览器配置
  （临时 `user-data-dir`，关窗即删），与日常浏览器的 Cookie / LocalStorage / 扩展
  完全隔离 —— 不会再出现「点加号却直接进了旧账号」。README 的「从本机导入」仍是
  显式备选，不会替你自动切过去。
- **登录成功就有稳定设备身份**：拿到账号作用域后**纯本地**分配/复用本机设备密钥
  （零请求），并把 `metadata.userId` / `metadata.accountScope` 一起落盘。
  **同一个号换 token 不换设备**，不同账号（不同 uuid）各自独立；旧版本留下的记录
  按**完全相同**的作用域迁移复用，不会复制别人的私钥。
- **旧设备记录一次迁好**：早期只有 identity 的记录在迁移时即补齐 device / inference，
  不再出现「第一次假 409、第二次才成功」；写入失败会保留源记录，不会误删设备身份。
- **加号更快也更干净**：浏览器发现先查静态路径并记忆化，不再每次同步跑几十次
  注册表查询；启动异常会关闭 loopback，不留端口或后台进程。

### 签到

- **未注册设备时，用户主动签到会自己把身份准备好**（账号档案 → 设备注册 → 活动列表
  → 领取），不再回「先发一次模型请求」这种用户点不动的提示。
- **失败就说失败**：设备没准备好（409 / 403 / 网络）时如实返回失败并带上状态码与原因，
  不会假报「已签到」、也不会在失败后继续去领奖。
- 设备注册只在**真正需要它**时发生（签到或第一次推理）；登录只分配本机身份，
  不做云端设备注册或自动领奖。

### 模型目录

- **价格未知 ≠ 免费**：目录条目缺价格 / `null` / 空对象 / 非法值 / 负数时**不列**
  （不猜、也不冒充 0）；只有服务端**显式写了 0** 才标 `free` ——
  免费模型不再被反复派发，收费模型也不会被标成免费。

### 安全

- **出站地址只认一个原点**：所有出站请求必须 `https` 且 origin 与
  `https://code.phanthy.com` 逐字一致；带 `user:pass@` 的地址、`//host/x` 这类协议相对
  写法、反斜杠路径一律拒绝，数据面与推理转发（loader）用的是同一个闸门 ——
  拼装错误不会把账号的访问令牌送到别的主机。
- **不自动跟随重定向**：数据面、设备注册、OAuth 换票与推理请求一律 `redirect: "manual"`，
  避免签名头被转发到另一台主机；3xx 明确按上游失败处理。
- 明文重建错误响应时移除 `content-encoding` / `content-length`，不再出现「gzip 头配明文」。

### 文档

- README 纠正旧文案：**「插件刷新后会把桌面端 `refresh_token` 写回」是错的**。
  生产代码里的「从本机导入」只接受**短效 access token**，明确拒绝 `refresh_token`，
  不会续写、也不会顶掉桌面端登录。
- README「已知限制」更正计费说明：按 **token** 计费（小请求会抹零），
  不再是「按次扣 1 积分」；除 `Phanthy-fast` 外没有免费模型。
- 新增探针用法：`node scripts/probe-checkin-live.mjs` **默认只预演、零网络**；
  只有显式加 `--yes` 才会真实注册（如需要）并领取签到，不调用 loader、不发推理请求，
  输出已脱敏。

## 0.1.0 — 2026-11-09

**首个版本：PhanthyCode（code.phanthy.com）独立接入 magpie，不需要桌面端。**

### 能做什么

- **两种登录**：浏览器 OAuth（PKCE + 本机 loopback 回调）与「从本机导入」（读桌面端
  已经刷好的云端 access token，只读、不复制 refresh_token / 推理令牌 / 设备私钥）
- **13 个模型**，倍率与官方客户端逐条一致（`0.04x` ~ `1.67x`），`Phanthy-fast` 标 `free`
- **额度面板**：积分余额 / 临期积分 / 套餐
- **每日签到**：`auth.checkin` 返回 `claimed` + `credit` + `streak`
- **推理直连**：`/v1/messages`、`/v1/responses`、`/v1/chat/completions`，12 段 canonical
  签名 + 推理令牌，403 兜底重试

### 真机实证的协议结论

每一条都是撞出来的，不是猜的（取证细节见 [PROTOCOL-INFERENCE.md](./PROTOCOL-INFERENCE.md)）：

1. **`installationId = "di_" + base64url(sha256(裸 32 字节 ed25519 公钥))`**
   —— 哈希的是**裸公钥**，不是 44 字节 DER 包装，也不含 accountScope。
   早期按 scope 哈希 / DER 包装算，服务端一律回 `409 desktop_installation_conflict`。
2. **三把独立 ed25519 密钥**（identity / device / inference）：
   `body.device_signature` 用 device 私钥、`x-desktop-signature` 用 identity 私钥、
   `x-phanthy-proof-signature` 用 inference 私钥。三把混用会 403。
3. **`x-phanthy-desktop-session` 就是 `desktop_inference_token` 本身**，不是 sessionId。
4. **令牌寿命是服务端定的**：`/oauth/token` 明确返回 `expires_in: 1800`（30 分钟），
   推理令牌 JWT 的 `exp - iat` 是 **3 分钟**。代码里的常量只是「服务端不给时」的回退值。
5. **12 段 canonical 的 session 段必须读「最终要发出去的头」** ——
   `x-phanthy-session` 被摊成 `x-claude-code-session-id` 之后，读原始请求头会拿到展开前的旧值，
   与实发头不一致 ⇒ 服务端算出另一个串 ⇒ 403。
6. **loopback 的 Host 校验必须接受 `localhost`** —— 授权服务器会把 `redirect_uri` 里的
   `127.0.0.1` 改写成 `localhost` 再跳回来，只认 `127.0.0.1:<port>` 就是 404，
   用户看到「浏览器登录成功 + magpie 永远转圈」。
7. **倍率 = `input_credits_per_million_tokens / 3000`**，12 条逐条命中官方客户端截图。
8. **`rate: 0` 不等于免费** —— magpie 不会从 `rate` 推 `free`，「0 积分」必须显式标。
   反过来，极小但非零的价格四舍五入到 `0.00x` 也不能标 free。
9. **「临期积分」不能是独立窗口** —— 它的 `amount` 与 `limit` 都是即将到期的余额，
   算出来 `used = 100%`，等于告诉 magpie「这个号已经用光了」。临期是**时间属性**，
   必须挂在唯一那条可路由窗口的 `runsOutAt` / `runsOut` 上。
10. **api 型登录态只有 `metadata.email` 能落盘** —— magpie 的 `/api/plugin-signin`
    对 `type: "api"` 只持久化 `{type, key, metadata}`，`accountId` / `uid` / `expires` 全丢。
11. **签到要用 `claimed` 不用 `done`** —— 宿主只把 `{outcome, credit, streak, message, until}`
    转给 Go，`claimed` 时间戳由 Go 在 `outcome === "claimed"` 时自己补。
    `done` 没有时间戳 ⇒ magpie 无法断言「这 300 分是今天的」⇒ 卡片永远黄灯。
12. **不要用环境变量当闸门** —— magpie 是独立进程，用户在 shell 里设的变量它看不到。
    早期 `PHANTHY_ALLOW_LOCAL_IMPORT=1` / `PHANTHY_ALLOW_DEVICE_REGISTER=1` 两道闸
    只会让用户「登录成功、额度正常、一发推理回 502」。现在默认放行，
    `PHANTHY_ALLOW_DEVICE_REGISTER=0` 才是显式 opt-out。

### 厂商计费行为（实测）

> ⚠ 只能用 `/api/oauth/usage` 的 `current_plan.used_credits` 量 —— 它是服务端结算后的
> **累计已用**，只增不减。`wallet.availablePoints` 会随「预留 / 结算」上下浮动，±1~3 的
> 噪声足以让人得出错误结论（本文件早期版本就因此错写成「按次固定扣 1」）。

实测（deepseek-v4.1-flash-1017，`0.10x`）：

| 请求 | 输入 | 输出 | 消耗 |
|---|---|---|---|
| 短问答 | 37 | 24 | **0** |
| 画一只鹈鹕（SVG） | 142 | 1247 | **0** |
| 长输出 | 46 | 2000 | **1** |

结论：**按 token 计费，小请求会抹零**，不是按次固定扣。
唯一无条件免费的是 `Phanthy-fast`（`0.00x`）。

`reservedPoints` 只涨不回落，存在未结算预留（上游账目，插件无法控制）。

### 兼容

- magpie ≥ 0.1.1763（稳定渠道 0.1.1327 亦可用）
- Windows 优先；macOS / Linux 走同一份实现（无平台特定代码）
