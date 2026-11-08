# PhanthyCode 云端 for magpie

把 [code.phanthy.com](https://code.phanthy.com) 的模型接进 magpie —— 登录、模型目录、额度、签到、
推理直连全在插件里，**不需要装官方桌面端**。

```
provider   phanthycode（模型名 phanthycode/<id>）
```

## 功能

- **官方 OAuth 登录** —— 授权码 + PKCE S256，本机 loopback 回调，`state` 校验与失败页齐备。
- **续期不丢号** —— 一次性 `refresh_token` 同账号串行，多账号并发刷新不会互相顶掉。
- **模型目录跟随账号** —— 登录后拉 `/api/phanthy_code/models`，校验 `schema_version`；接口抖动退回上次快照，不返回空列表。
- **额度上卡片** —— 套餐名 + 积分余额，**临期积分挂在同一条可路由窗口上**（智能路由的「到期前用完」才有输入）。
- **每日签到** —— 自动领取 + 幂等键（同一 installationId + 同一天只发一条）；卡片显示「今日已签到 +N · 连续 M 天」。
- **设备身份自己生成** —— 插件自造 ed25519 密钥并落 `~/.cache/magpie`，**不读取、不依赖**官方桌面端。
- **两种登录方式** —— 浏览器 OAuth，或「从本机导入」官方客户端已经刷好的云端 access token。
- **错误不误杀账号** —— 非登录语义的 401/403 带 `X-Magpie-Sign-In: kept`；超时一律 504；模型级错误 404。

## 模型

**DeepSeek / GLM（智谱）/ Kimi（月之暗面）/ Phana / Phano / Phanthy 自有档位**，
登录后跟随账号目录上下架。

| 发行商 | 代表模型 |
|---|---|
| Phanthy 自有 | `Phanthy-fast`（**免费**）· `Phanthy-pro` · `Phanthy-ultra` |
| DeepSeek | `deepseek-v4.1-flash-1017` |
| GLM（智谱） | `glm-5.2` · `glm-5.3` · `glm-5.3-flash` |
| Kimi（月之暗面） | `kimi-k2.7-code` · `kimi-k3` |
| Phana / Phano | `Phana-5.5o` · `Phana-5.5s` · `Phano-6.1s` · `Phano-6a` |

上下文窗口、倍率、思考档位一律由云端目录下发（README 不抄，抄了就过期）；装好以后
`magpie plugin list` 拿到的才是这个账号真实的全部。

**倍率** = `input_credits_per_million_tokens / 3000`，与官方客户端逐条一致（`0.04x` ~ `1.67x`）。
计费**按 token**（小请求会抹零：画一张 1247 token 的图实测 0 积分），无条件免费的只有 `Phanthy-fast`。

## 签到

每天一次，`daily-login` 领取走 v1 签名 + `idempotency-key`（同一 installationId + 同一天只发一条）。
**默认就会领取**，不需要任何环境变量；已经领过时自动转成「今日已签到」并带上金额与连续天数。
失败只影响签到，不影响模型与额度。

在 magpie 的 **设置 → 用量** 里可以打开或关掉「自动签到」。

## 安装

在 magpie 的 **插件 → 发现** 搜 `PhanthyCode`，点**安装**。

### 命令行

```bash
# 从 GitHub
magpie plugin add baijiu666/magpie-PhanthyCode

# 本地开发
magpie plugin add D:/path/to/magpie-PhanthyCode
```

装完在插件设置里选登录方式：

| 方式 | 说明 |
|---|---|
| 浏览器 OAuth（推荐） | 自己换票，access + refresh 都归插件，能自动续期 |
| 从本机导入 | **只导入云端 access token**（短效）；需要官方桌面端已经登录过 |

## 环境变量

只有一个，而且是**关闭**用的 —— 默认一切都会自动跑：

| 变量 | 作用 |
|---|---|
| `PHANTHY_ALLOW_DEVICE_REGISTER=0` | 显式禁止向云端注册本机设备身份（推理面会不可用）。不设 = 允许 |

> 早期版本有三个 `=1` 才生效的闸门（本机导入 / 设备注册 / 签到）。它们全删了 ——
> **magpie 是独立进程**，用户在 shell 里设的环境变量它看不到，那道门只会让功能对所有人都是死的。

## 已知限制

- 厂商按次扣 1 积分，**除 `Phanthy-fast` 外没有免费模型**
- `reservedPoints` 只涨不回落（上游账目，插件无法控制）
- 桌面端的 `refresh_token` 是一次性轮换的：插件刷新后会把新值写回
  `~/.phanthy-code/.credentials.json`，不会把桌面端顶下线

## 文档

| 文件 | 管什么 |
|---|---|
| [PROTOCOL-INFERENCE.md](./PROTOCOL-INFERENCE.md) | 完整协议取证（12 段 canonical、三把密钥、令牌寿命） |
| [HOOKS.md](./HOOKS.md) | magpie 插件契约（字段级） |
| [AGENTS.md](./AGENTS.md) | 给 AI 执行者的入口与「会静默出错」的坑表 |
| [CHANGELOG.md](./CHANGELOG.md) | 更新记录 |

## 许可

MIT —— 见 [LICENSE](./LICENSE) 与 [NOTICE.md](./NOTICE.md)。
