# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页，再按 AGENTS.md「一、先定位你在哪一步」读对应文档。
> 每次干完活必须更新「当前状态」与「下一步」。
>
> ⚠ 这份文件里的数字由 `node scripts/check-docs.mjs` 对着实测核（src 模块数 / tests 文件数），
> 写错了门禁会红 —— 别手改数字，改代码后按实测更新。

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `baijiu666/magpie-PhanthyCode`（上游 `main`；本地修复工作树） |
| npm 包名 | `magpie-phanthycode`（`scripts/publish-npm.mjs` 的 `PUBLISH_AS`） |
| 当前版本 | `0.2.0` |
| provider id | `phanthycode` |
| 定位 | 把 `code.phanthy.com` 的模型接进 magpie / OpenCode：官方 OAuth + PKCE、自己的 ed25519 设备身份、模型目录、额度；**不依赖桌面端** |
| 静态逆向基准 | `PhanthyWork-windows-x64.exe`（2026-11-04，53,338,570 B）—— 协议结论的出处见 `src/proof.mjs` / `src/registration.mjs` / `src/catalog.mjs` 的文件头 |

## 二、当前状态（2026-11-09）

```text
分支        feat/invite-mode（基于 0.1.1 修复提交；未 commit / push）
版本        0.2.0（本地修复版；未发 npm、未推远端）
本批范围    邀请协议 + 邀请源（最新 / 首选 / 预留）+ invite_mode 顶部开关；详见 CHANGELOG 0.2.0
```

| 资产 | 数量 |
|---|---|
| `src/` 模块 | 44 个（装配链可达 33 个，其余见第八节决策） |
| `tests/` 文件 | 59 个（740 条用例全过） |
| `HOOKS.md` | 14 章字段级钩子契约（一～十四，含四之一、四之二、九之二/九之三、十一之二/之三） |
| AGENTS.md 坑表 | 43 条（坑表编号 14 出现两次，是原稿如此） |
| `index.mjs` | 只做九项钩子装配 + 邀请模式接线 + 请求期 / 账号辅助函数 |

## 三、已接的装配（九项）

| 钩子 | 实现在哪 |
|---|---|
| `config` | `index.mjs` + `src/context.mjs` 的 `staticModels()` |
| `auth.methods`（oauth / api） | `index.mjs` + `src/oauth.mjs` + `src/oauth-pkce.mjs` + `src/local-import.mjs` + `src/invite.mjs` + `src/invite-source.mjs`（邀请源策略，不新增登录方式） |
| `auth.refresh` | `src/refresh-lock.mjs` + `src/oauth.mjs` |
| `auth.loader` | `index.mjs`（签名）+ `src/proof.mjs` + `src/production-auth.mjs` |
| `auth.usage` | `src/usage-windows.mjs` + `src/usage-cache.mjs` + `src/quota.mjs` + `src/referrals.mjs`（顺带采集本账号邀请码） |
| `auth.checkin` | `src/activity.mjs` + `src/checkin.mjs` + `src/referrals.mjs`（同上，失败不影响签到） |
| `provider.models` | `src/catalog.mjs` + `src/catalog-cache.mjs` + `src/models.mjs` |
| `chat.headers` | `index.mjs` |
| 数据字段（icon / maxConcurrency / accountId / uid） | `src/context.mjs` + `src/credential.mjs` |

## 四、验证记录（0.2.0）

- `npm test`：741 通过 / 0 失败（离线；`tests/helpers/network-guard.mjs` 拦外部出站）；
- `node scripts/check.mjs`：通过 48 / 警告 1 / 失败 0（警告是既有 `scripts/probe-loader.mjs` 的静态 UA 检查）；
- `node scripts/check-ua.mjs .`：失败 0 / 警告 1；
- `node scripts/check-error-codes.mjs .`：规则 R1–R9 全覆盖，失败 0；
- `node scripts/check-docs.mjs`：退出 0；
- `node scripts/privacy-scan.mjs`：PASS（0 处）；
- `git diff --check`：退出 0（无空白错误）；
- `npm pack --dry-run`：白名单为运行时 + 必要文档（见 `package.json` 的 `files`）；
- **真实取码已验证（2026-11-09，本机生产环境）**：0.2.0 部署并重启 magpie 后，
  该账号自己的 `usage` 钩子走完 `GET /referrals/me` → `POST /referrals/code`，
  在 `~/.cache/magpie/phanthycode-invite-code-<uid>.json` 落下一张真实邀请码
  （`slot: 1`，`shareUrl` 为官方 `/r/<code>` 形态）；全程零 bind、零推理请求。
  同时 `src/preferred.mjs` 读本机 `logins.json` / `plugin-auth.json` 得到首选账号的
  `metadata.userId`（`reason: "ok"`）——置顶开关的声明形状也已被 0.1.3371 宿主识别。
- 本地未提交版不打 tag、不发布，因此不把 `check-maintenance.mjs` 的发布/tag 检查伪写成已通过。

## 五、下一步（按优先级）

1. **真实邀请注册未验证**：新手机号从 `/login?next=…&referral_state=…` 进入并完成注册后，
   邀请人 `referrals/me` 的 `tier_granted_count` 是否 +1、`relations` 是否出现新号 —— 需要
   新手机号 + 短信验证码，只能真机验。离线测试只钉住「URL 构造 / 回退 / 零写接口调用」，
   **不能**写成「邀请奖励已到账」。
2. **完整 OAuth 真机验收未验证**：点一次「+」走完整 PKCE，确认 loopback 仍收到 `code`
   （授权 URL 被包进 `next` 后 `redirect_uri` 是否被服务端再次规范化）；以及已登录会话打开
   邀请链接时是否直接跳 `next`。两项都还没有真机结论。
3. **隔离浏览器真机验收**：用户实际点一次「加号」，确认 Chrome/Edge 的 Profile Path 是新的
   `phanthy-isolated-login-*` 临时目录，且不会直接复用旧 Phanthy 会话；个别全局单例国产浏览器需单独观察。
4. **真实签到已验收（2026-11-09）**：首次 `--yes` 返回 `claimed / +300`，第二次返回
   `今日已签到`；设备记录保持 1 条、作用域匹配、三把密钥齐全。后续观察宿主自动签到与界面刷新。
5. **私钥静态保护**：当前依赖用户目录 ACL；若要加 DPAPI/系统 keychain，需另做跨平台回退与迁移测试，
   不在本轮签到修复里夹带。
6. **未接入模块瘦身**：第八节 11 个未接入模块若要删，必须连同测试与文档逐项处理，不只改打包白名单。
7. **上游发布**：只有用户明确要求时才走分支、PR、CI 与受控发布；本地修复不等于已发布。

## 六、硬约束

- 不推远端、不发网络请求；测试一律 mock/离线（`tests/helpers/network-guard.mjs`）。
- 错误码只用 `ERROR-CODES.md §3` 冻结词表；出站 `fetch` 一律显式官方 UA（`src/http.mjs` 的 `OFFICIAL_UA`）。
- 不加任何绕过鉴权 / 额度 / 风控的逻辑；未知契约维持 `DeviceContractPending`，不猜。
- 发布前必跑：`node --test`、`npm run check`（含 check:errors / check:ua）、`node scripts/check-docs.mjs`、
  `npm pack --dry-run`、`node scripts/privacy-scan.mjs --staged`、`node scripts/check-maintenance.mjs`。
- 改 `HOOKS.md` 的结论前先跑 `python extract-contract.py && node scripts/contract-diff.mjs`。

## 七、给接手者的最短路径

1. 读本文件与 `CHANGELOG.md` 顶部一节；
2. `git log --oneline --decorate -10` + `git tag` 核实现状；
3. 按 AGENTS.md 定位表读对应专档；
4. 修改后跑完整测试与交付门，再更新本文件（数字用实测值）。

## 八、装配链与死代码决策（审计 F11 / F12）

判据：从 `index.mjs` 做传递 import 可达。**当前 30 / 41 可达**（0.2.0：`invite` 接线；0.1.1 起新增 `origin` 与 `isolated-login`，后者复用 `browser-login` 的浏览器发现）。

**已处理**

| 模块 | 处理 | 理由 |
|---|---|---|
| `src/desktop-import.mjs` | **删除** | 0 引用、0 测试，且与本插件「不读取桌面端」的明文边界冲突（README 第 5 行） |
| 额度卡片（原 `index.mjs` 内联） | 搬进 `src/usage-windows.mjs` | 坑 18：入口只做装配；顺带把「钱包占比窗口 / until 时区」两处语义单独可测 |
| `src/models.mjs` 的 `isUsable` | **接上**（`catalogEntries` 调用） | 坑 20：不过滤就会把 embedding / 生图行列进 chat 列表 |
| `src/invite.mjs` | **接上**（`index.mjs` 的 oauth 方法） | 0.2.0 的邀请模式：`buildInviteLoginUrl` 包装授权 URL，`fetchReferralState` 只在 `ask()` 里抓一次公开分享页；仍**不**碰 `referrals` 写接口 |

**保留（有测试、可复用，但当前装配链不需要）** —— 11 个：
`catalog-union` `chat` `local-browser` `oauth-device` `openai-sse`
`request-rewrite` `rotation-captcha` `stream-reader` `tempmail-client` `tool-schema` `vision-clock`。

理由：它们是 `RECYCLING.md` 里那套通用工具（多站点 / 验证码 / 临时邮箱 / 非流折叠 /
工具 schema 适配），每个都有对应测试文件；本插件的协议面（Anthropic 透传 + OAuth + 设备签名）
用不到其中任何一条。删掉等于把可复用代码连同测试一起丢，接上等于凭空扩大攻击面和维护面 ——
两者都不如「保留 + 在这里登记」。**新增钩子时如果要接其中任何一个，先补行为测试再接线。**

**已知风险**：这些模块随 `files` 白名单里的 `src` 一起发布（约 100 KB 未执行代码）。
如果某个插件版本要瘦身，逐个删 + 同步删测试，别只从 `files` 里挖。

**`index.mjs` 体量**：九钩子装配 + 两个请求期辅助（`callUpstream` 超时分类、
`withSignInHint` 401 kept 头）。**行数这里不抄** —— 改一行注释就漂（t8 V-01/V-02 就是这么来的）：
要量就 `node -e "console.log(require('fs').readFileSync('index.mjs','utf8').split('\n').filter(l=>l.trim()).length)"`。
剩下能搬的是 `loader` 里的签名拼装（约 90 行），
但它是「一次读完全部约束才敢改」的一段 —— 拆开会让「body 字节 → canonical → 签名 → 原样发出」
的先后顺序失去局部性。**在拿到真实注册契约前不动它。**
