# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 接手前先读这一页，再按 AGENTS.md「一、先定位你在哪一步」读对应文档。
> 每次干完活必须更新「当前状态」与「下一步」。
>
> ⚠ 这份文件里的数字由 `node scripts/check-docs.mjs` 对着实测核（src 模块数 / tests 文件数），
> 写错了门禁会红 —— 别手改数字，改代码后按实测更新。

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `magpie-phanthycode`（独立 Magpie 插件；本地 git，无远端） |
| npm 包名 | `magpie-phanthycode`（`scripts/publish-npm.mjs` 的 `PUBLISH_AS`） |
| 当前版本 | `0.2.3` |
| provider id | `phanthycode` |
| 定位 | 把 `code.phanthy.com` 的模型接进 magpie / OpenCode：官方 OAuth + PKCE、自己的 ed25519 设备身份、模型目录、额度；**不依赖桌面端** |
| 静态逆向基准 | `PhanthyWork-windows-x64.exe`（2026-11-04，53,338,570 B）—— 协议结论的出处见 `src/proof.mjs` / `src/registration.mjs` / `src/catalog.mjs` 的文件头 |

## 二、当前状态（2026-11-08）

```text
分支        master（本地仓库，无 remote；tag v0.1.0 = 审计前基线，v0.2.0 = 审计修复版，v0.2.1 = 验收修复版，v0.2.2 = 收尾修复版，v0.2.3 = 台账行数订正）
版本        0.2.3（已打 tag；未发 npm、未推远端 —— 团队范围禁止）
本批范围    审计 F1–F27 + 逆向矛盾 T2-1…T2-4；详见 CHANGELOG 0.2.0
```

| 资产 | 数量 |
|---|---|
| `src/` 模块 | 39 个（装配链可达 25 个，其余见第八节决策） |
| `tests/` 文件 | 47 个（`node --test` 全过） |
| `HOOKS.md` | 14 章字段级钩子契约（一～十四，含九之二/九之三、四之二、十一之二/之三） |
| AGENTS.md 坑表 | 38 条（坑表编号 14 出现两次，是原稿如此） |
| `index.mjs` | 只做九项钩子装配 + 两个请求期辅助函数（`callUpstream` / `withSignInHint`） |

## 三、已接的装配（九项）

| 钩子 | 实现在哪 |
|---|---|
| `config` | `index.mjs` + `src/context.mjs` 的 `staticModels()` |
| `auth.methods`（oauth / api） | `index.mjs` + `src/oauth.mjs` + `src/oauth-pkce.mjs` + `src/local-import.mjs` |
| `auth.refresh` | `src/refresh-lock.mjs` + `src/oauth.mjs` |
| `auth.loader` | `index.mjs`（签名）+ `src/proof.mjs` + `src/production-auth.mjs` |
| `auth.usage` | `src/usage-windows.mjs` + `src/usage-cache.mjs` + `src/quota.mjs` |
| `auth.checkin` | `src/activity.mjs` + `src/checkin.mjs` |
| `provider.models` | `src/catalog.mjs` + `src/catalog-cache.mjs` + `src/models.mjs` |
| `chat.headers` | `index.mjs` |
| 数据字段（icon / maxConcurrency / accountId / uid） | `src/context.mjs` + `src/credential.mjs` |

## 四、验证记录（0.2.4）

- `node --test`：481 通过 / 0 失败（离线；`tests/helpers/network-guard.mjs` 拦外部出站）；
- `node scripts/check.mjs`：通过 48 / 警告 1 / 失败 0（警告是 `scripts/probe-register-desktop.mjs`
  的静态误报：它走 `registerDevice` → `headersFor` 补 UA，字面量不在该文件里）；
- `node scripts/check-ua.mjs .`：退出 0（`OFFICIAL_UA = Bun/1.3.14`，2026-11-09 抓包实测）；
- `node scripts/check-error-codes.mjs .`：规则 R1–R9 全覆盖，失败 0；
- `node scripts/check-docs.mjs`：退出 0；
- `node scripts/check-maintenance.mjs`：退出 0（git + tag + CHANGELOG 对得上）；
- `node scripts/privacy-scan.mjs`：PASS（0 处）；
- `npm pack --dry-run`：白名单收窄到运行时 + 必要文档（见 `package.json` 的 `files`）。

## 五、下一步（按优先级）

1. **真机四问验收（v2-t4）**：三把密钥 → 注册 200 → activities 拿令牌 → `/v1/messages` 出模型输出，
   四条都跑过才算推理面接通（`scripts/probe-e2e.mjs` 是同一链路的独立证明）。
2. **`runsOutAt` / `runsOut`**：额度作废时间需要厂商字段名，目录/用量响应里没有已证实的键 → 暂不产出
   （CHECKLIST A-4 备注里登记了这条缺口）。
3. **`/api/oauth/usage/summary`、`/api/oauth/account/settings`、`/api/oauth/referrals/*`**：二进制里有、插件未覆盖，
   等有字段级证据再接。
4. **`/v1/messages` 的 inference 证明签名轮换**：现在每次注册换一把 inference 会话密钥；
   令牌过期后是复用同一把还是重新注册，等真机长跑观察（当前按「过期即重跑注册」处理）。
5. **重试语义（`PROTOCOL-INFERENCE.md §七`）未实现**：401 刷新 OAuth 后重试一次、
   403 `request_not_authorized` 换推理令牌重试最多 2 次 —— 插件目前直接透出错误，
   令牌过期需要用户重登 / 重启。实现时要连同「20 秒重试窗口」一起做，别只加重试。

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

判据：从 `index.mjs` 做传递 import 可达。**当前 25 / 39 可达**（0.2.1：`context.mjs` 现在走 `model-context.mjs` 查窗口，故后者进入装配链）。

**已处理**

| 模块 | 处理 | 理由 |
|---|---|---|
| `src/desktop-import.mjs` | **删除** | 0 引用、0 测试，且与本插件「不读取桌面端」的明文边界冲突（README 第 5 行） |
| 额度卡片（原 `index.mjs` 内联） | 搬进 `src/usage-windows.mjs` | 坑 18：入口只做装配；顺带把「钱包占比窗口 / until 时区」两处语义单独可测 |
| `src/models.mjs` 的 `isUsable` | **接上**（`catalogEntries` 调用） | 坑 20：不过滤就会把 embedding / 生图行列进 chat 列表 |

**保留（有测试、可复用，但当前装配链不需要）** —— 14 个：
`account-name` `browser-login` `catalog-union` `chat` `invite` `local-browser` `oauth-device`
`openai-sse` `request-rewrite` `rotation-captcha` `stream-reader` `tempmail-client` `tool-schema`
`vision-clock`。

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
