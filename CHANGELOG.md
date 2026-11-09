# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与规矩见 [UPDATING.md](./UPDATING.md)。

## 0.2.0 — 2026-11-09

**邀请模式：一个 provider 级开关（默认关）。关闭 = 自动用「最新注册账号」的邀请链接；
开启 = 用 magpie 账号页的「首选账号」（Make first）。账号自己的邀请链接由插件在该账号自己的
usage / checkin 里采集 —— 不改登录方式、登录路径不碰邀请写接口。**

### 邀请模式（`invite_mode`）

- **开关在哪**：`auth.options[]` 里的 provider 级开关，`default: false`，
  `placement: "top"`。magpie **≥ 0.1.2985** 把它画在**账号下方、Routing 上方**；
  旧版忽略该字段，开关回退到最下面的「插件选项」，**功能照常、不报错**。
  字段是字符串 `placement: "top"`，**不是** `top: true`（`optionsOf()` 只读 `placement`）。
- **开关实时生效**：每次问答 / 登录都重新读一次 `input.magpie.option(provider, key)`，
  切换后**不用重启**。没有新增登录方式：`auth.methods` 仍是 `oauth` + `api`。
- **关闭（默认）= 自动选源**：用**最新注册账号**的邀请链接；最新那个还没码（或已被判死）→
  回退**上一个有码且合格**的账号；都没有 → 用**预留邀请码**；再没有 → **不带邀请、照常登录**。
  「最新」= 本机**第一次见到**这个账号的时刻（`firstSeenAt` 只写一次），不是「最后登录时间」——
  重登旧号不会把下一次注册挂到旧号名下。
- **开启 = 首选账号**：只用 magpie 账号页「**Make first**」那个账号的码。首选没码 / 没资格 /
  未设置 → **只**回退预留码，**绝不静默改用别的账号**。
- **用户手填邀请码优先于自动源**：填非 `0` / `1` 的码 → 覆盖自动源；`0` / `1` / 留空 → 走自动源（最新 / 首选，含预留兜底）
  （写成新的预留值）。预留值在 `~/.cache/magpie/phanthycode-invite.json`，
  **不会被自动派生覆盖**（自动派生的码只进每账号的 `phanthycode-invite-code-<key>.json`）。

### 三个新模块

- **`src/referrals.mjs`** —— 「账号自己的邀请链接」：`GET /referrals/me` 只读资格
  （**永远没有码**），`POST /referrals/code` 才是取码入口（body 字面量 `{}` +
  幂等键 `referral-code:<installationId>:<ms>` + v1 签名）。不 bind、不重试、不碰推理端点、
  不抓 `/r/<code>`、不把码写进日志。
- **`src/invite-source.mjs`** —— 邀请源策略 + 本地缓存：账号索引
  `phanthycode-invite-accounts.json`（只放身份与时间）、每账号
  `phanthycode-invite-code-<key>.json`（只放白名单字段）。键是 **uid**
  （`metadata.userId` = `fingerprint(accountScope)`），**绝不**用可重名的 `accountId`。
- **`src/preferred.mjs`** —— 「首选账号」的只读解析：`logins.json` 的
  `first: true` → 最小正 `order` → 第一行，`home` 再进 `plugin-auth.json` 取
  `metadata.userId`。只读身份与选择字段，**绝不读** token；读不到就回退预留码（不静默换人）。

### 邀请码从哪来（采集边界）

- **只在该账号自己的 `usage()` / `checkin()` 里采集**：该账号已有码 → 跳过；距上次尝试
  **< 24h**（失败也计入）→ 跳过；设备**未注册** → 跳过（绝不 force 注册）。
  顺序是**先查资格（`/referrals/me`）、再取码（`/referrals/code`）**。
- **失败只降级**：任何失败只记 reason（内存），不影响额度主结果、不让签到变红，也不伪造奖励。
- **不借别人的码**：每个账号只用**自己的** Bearer + 设备签名取自己的码；token 刷新不换键。

### 出站与日志

- **`ask()` 是唯一出站点**：有码才抓**一次**公开分享页 `/r/<code>`（匿名 GET、同 origin、
  官方 UA、10s 超时）；**`authorize()` 里零出站**，它只读本次进程里换好的 `referral_state`
  去包装授权 URL（`/login?next=<完整授权 URL 逐字>&referral_state=rs1.…`）。
- **失败不阻塞登录**：分享页失败 / 没有 `rs1.…` / 码为空或不合法 → 回退**裸授权 URL**，
  登录照常完成；登录说明只给固定分类文案（`no_code` / `http_error` / `no_state` …），
  **不含**邀请码、`share_url` 与 `referral_state` 原值。

### 边界（明确不做）

- **只对新注册账号有效**：邀请关系在**注册那一刻**建立；已存在的账号**不能事后补绑**
  （服务端明确回 409），插件**不重试**、也不把它当临时故障刷屏。
- **登录路径不调 referrals 写接口**：不会出现 `POST /api/oauth/referrals/bind`；
  取码只发生在 `usage` / `checkin` 的有界采集里（每账号 24h 至多一次）。
- **不伪造邀请奖励**：不写 `tier_granted_count` / `relations` / 奖励积分，也不把「已邀请」
  当成本地状态。

### 测试

- 离线用例 **740 条全过**（新增/改写 `invite-source` / `referrals` / `preferred` /
  `invite-wire` / `invite-mode` / `invite-protocol` 六份邀请相关测试）；全部假 `fetch` +
  临时 HOME，不联网、不碰真凭证。

> 插件侧**不校验、也不承诺**奖励是否到账：是否建立关系、是否计入奖励由服务端判定，
> 离线测试覆盖的只是「源选择 / URL 构造 / 回退 / 采集边界 / 零 bind」这些可验证的契约。

## 0.1.1 — 2026-11-09

**本地修复版：登录更省心、签到不再要求「先发一次模型请求」、价格未知的模型不再被当成免费。**
（只在本机验证；不推送、不发布。）

### 登录与设备身份

- **加号默认开一扇干净的浏览器**：OAuth 登录每次都用一份**一次性**浏览器配置
  （临时 `user-data-dir`，关窗即删），与日常浏览器的 Cookie / LocalStorage / 扩展
  完全隔离 —— 不会再出现「点加号却直接进了旧账号」。README 的「从本机导入」仍是
  显式备选，不会替你自动切过去。
- **开不出干净窗口也照样能登录**：没装 Chromium（macOS 只有 Safari、Linux 只有 Firefox、
  无界面的机器）、启动报错、或单实例浏览器（360 / QQ / 搜狗…）把参数转交给已运行实例时，
  自动**退回用你的默认浏览器**打开授权页（提示语会写明），不会因此没有 OAuth 入口。
  转交后「进程起来过但 profile 没被用上」会被启动后校验识别出来，按启动失败处理。
- **临时 profile 删不掉会如实说**：删除失败不再谎报「已删除」，下一次关闭会重试；
  实测删得掉的场景照旧「关窗即删」。
- **登录成功就有稳定设备身份**：拿到账号作用域后**纯本地**分配/复用本机设备密钥
  （零请求），并把 `metadata.userId` / `metadata.accountScope` 一起落盘。
  **同一个号换 token 不换设备**，不同账号（不同 uuid）各自独立；旧版本留下的记录
  按**完全相同**的作用域迁移复用，不会复制别人的私钥。
- **旧设备记录一次迁好**：早期只有 identity 的记录在迁移时即补齐 device / inference，
  不再出现「第一次假 409、第二次才成功」；写入失败会保留源记录，不会误删设备身份。
- **加号更快也更干净**：浏览器发现先查静态路径并记忆化（找不到时不缓存，装完即生效），
  不再每次同步跑几十次注册表查询；授权地址与换票地址都过出站 origin 闸门。

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
