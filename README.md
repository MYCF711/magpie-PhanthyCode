# PhanthyCode for magpie

**一个插件把 `code.phanthy.com` 的模型接进 magpie / OpenCode —— 不用装桌面端。**

官方 OAuth + 自带 ed25519 设备身份，模型目录、额度、签到都走云端自己的接口。

```
provider   phanthycode（模型名 phanthycode/<id>）
模型        登录后按账号实时拉取（云端目录 schema_version 1）
额度        套餐 + 积分余额，1 条占比窗口参与智能路由
依赖        0 个运行时依赖（只用 node: 内置模块）
```

---

## 功能

- **官方 OAuth 登录** —— 授权码 + PKCE S256，本机 loopback 回调，`state` 校验与失败页齐备。
- **续期不丢号** —— 一次性 `refresh_token` 同账号串行，多账号并发刷新不会互相顶掉。
- **模型目录跟随账号** —— 登录后拉 `/api/phanthy_code/models`，校验 `schema_version`；接口抖动退回上次快照，不返回空列表。
- **额度上卡片** —— 套餐名 + 积分余额；钱包给了总额就出一条**带占比**的窗口（智能路由才认这个号）。
- **签到（默认只读）** —— 只读今日签到状态；要真领取需显式开 `PHANTHY_ALLOW_CHECKIN=1`，同账号单飞、幂等。
- **设备身份自己生成** —— 插件自造 ed25519 密钥并落 `~/.cache/magpie`，**不读取、不依赖**官方桌面端。
- **本机导入登录（默认关闭）** —— 只取本机官方客户端的云端 access token，不复制 `refresh_token`、推理令牌或设备私钥。
- **错误不误杀账号** —— 非登录语义的 401/403 带 `X-Magpie-Sign-In: kept`；超时一律 504；模型级错误 404。

## 模型

**DeepSeek / GLM（智谱）/ Kimi（月之暗面）/ Claude**，外加厂商自有档位 `phanthy-fast` / `phanthy-pro` / `phanthy-ultra` —— 登录后跟随账号目录上下架。

| 发行商 | 代表模型 |
|---|---|
| PhanthyWork 自有档位 | `phanthy-fast` · `phanthy-pro` · `phanthy-ultra` |
| DeepSeek | `deepseek-v4.1-flash-*` |
| GLM（智谱） | `glm-5.3` · `glm-5.3-flash` |
| Kimi（月之暗面） | `kimi-k2.7-code` |
| Anthropic | `claude-opus-4-8` · `claude-sonnet-4-6` |

上下文窗口、倍率、思考档位一律由云端目录下发（README 不抄，抄了就过期）；装好以后
`magpie plugin list` 拿到的才是这个账号真实的全部。

## 签到

每天一次，`daily-login` 领取走 v1 签名 + `idempotency-key`（同一 installationId + 同一天只发一条）；
默认**只读状态**，要真领取请设 `PHANTHY_ALLOW_CHECKIN=1`。失败只影响签到，不影响模型与额度。

## 安装

在 magpie 的 **插件 → 发现** 搜 `PhanthyCode`，点**安装**。

装完在插件设置里选登录方式：

| 方式 | 开关 | 导入什么 |
|---|---|---|
| 浏览器 OAuth（默认） | 无 | 自己换票，access + refresh 都归插件 |
| 从本机导入 | `PHANTHY_ALLOW_LOCAL_IMPORT=1` | **只导入云端 access token**（短效，仅数据面） |

另外两个开关默认关闭，打开才会发对应请求：

| 变量 | 作用 |
|---|---|
| `PHANTHY_ALLOW_DEVICE_REGISTER=1` | 允许向云端注册本机设备身份（推理面前置；服务端可能回 `409 device_binding_conflict`，那是终态） |
| `PHANTHY_ALLOW_CHECKIN=1` | 允许**真正领取**每日签到奖励 |

### 命令行

```bash
# 从 npm（推荐）
magpie plugin add magpie-phanthycode

# 从仓库源码（拿最新代码，不走 npm）
magpie plugin add github:<owner>/magpie-phanthycode

# 本地 tgz（自己改了代码）
npm pack --pack-destination ./dist
cp dist/magpie-phanthycode-*.tgz ~/.config/magpie/plugins/dist/
# plugins.json          追加 { "spec": "magpie-phanthycode" }
# plugins/package.json  追加 "magpie-phanthycode": "./dist/magpie-phanthycode-*.tgz"
cd ~/.config/magpie/plugins && ~/.cache/magpie/bun/1.4.4/magpie-bun.exe install
```

装完确认：

```bash
magpie plugin list
# magpie-phanthycode  on
#   phanthy (PhanthyCode, N models)  signed in as <账号>
```

> 改了代码要 bump `version` 再打包 —— 同版本号重打，bun 会命中缓存（输出 `no changes`）。

## 常见问题

**登录后模型列得出来，对话却报 `501 not_implemented`？** 设备的推理面契约还没定（三项签名语义缺证据），
插件不猜。数据面（目录 / 额度 / 签到）不受影响；要试注册设 `PHANTHY_ALLOW_DEVICE_REGISTER=1`。

**会不会把官方桌面端顶下线？** 不会。插件在**自己生成**的 ed25519 身份上签名；本机导入只取 access token，
`refresh_token` / `desktop_inference_token` / 设备私钥一律拒绝（规则写在 `src/local-import.mjs`）。

**卡片上的账号名为什么显示成供应商名？** 换票响应里没有 profile，插件不拿内部 id 冒充账号名
（`accountId` 留空，宿主回退成供应商名）；同名账号靠 `uid`（凭据指纹）区分。

**额度那里为什么写「积分余额」而不是百分比？** 钱包没给「总额」时不敢算分母；给了总额就会自动变成占比窗口
（只有带 `used` 的窗口才参与智能路由排序）。

**上游某个模型回 401，会不会把我整个账号停掉？** 不会。非登录语义的 401/403 会带
`X-Magpie-Sign-In: kept`，宿主只搁置这个模型；真登录失效（正文提到 token/session）才标账号。

**插件会不会读写 magpie 自己的配置？** 只写 `~/.cache/magpie/phanthycode-device-phanthycode__<账号指纹>.json`
（设备身份，0600），不碰 `~/.config/magpie` 的 `plugins.json` / `auth.json`。

## 参考源

来源与用在哪（完整版权声明见 [NOTICE.md](./NOTICE.md)、许可见 [LICENSE](./LICENSE)）：

| 来源 | 用在哪 |
|---|---|
| [MYCF711/magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT） | 插件骨架、`scripts/` 检查门、文档结构 |
| [magpie-community/plugins](https://github.com/magpie-community/plugins)（MIT） | loopback OAuth 的 state/Host 校验、refresh 单飞、SSE 折叠、签到账单差集 |
| [MYCF711/magpie-magicrew-auth](https://github.com/MYCF711/magpie-magicrew-auth)（MIT） | 查 `~/.cache/magpie/models.json` 的上下文索引模式（`src/model-context.mjs`） |
| [magpie 官方文档](https://usemagpie.ai/docs/zh/plugins) | 九钩子契约的字段级含义（`HOOKS.md` 逐条落地） |

> 更新记录：[CHANGELOG.md](./CHANGELOG.md)

## 许可

MIT。
