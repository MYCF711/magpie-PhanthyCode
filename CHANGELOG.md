# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与规矩见 [UPDATING.md](./UPDATING.md)。

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
