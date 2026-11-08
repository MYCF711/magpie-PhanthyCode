# 在用插件通用代码回收记录

> 快照：2026-11-03。启用清单以 `~/.config/magpie/plugins.json` 为唯一真源，
> 版本读自实际加载目录的 `package.json`；不把残留 `node_modules`、备份目录或未启用仓库算作在用插件。
> 本文件只记录回收边界与依据，不包含账号、Cookie、token 或本机私有路径。

## 1. 当前真实启用：17 项

| 配置 spec / 仓库 | 实际包名 | 版本 |
|---|---|---:|
| `@magpie-community/opencode-workbuddy-auth` | 同名 | 0.2.20 |
| `@magpie-community/opencode-zen-free-auth` | 同名 | 0.1.23 |
| `@magpie-community/opencode-qoder-auth` | 同名 | 0.2.59 |
| `@magpie-community/opencode-raccoon-auth` | 同名 | 0.1.5 |
| `@magpie-community/opencode-copilot-auth` | 同名 | 0.1.1 |
| `tk103331/magpie-qiniu-plugin` | `magpie-qiniu-plugin` | 0.1.0 |
| `MYCF711/magpie-officeace` | `magpie-officeace` | 0.2.5 |
| `MYCF711/magpie-loomy-auth` | `magpie-plugin-loomy-auth` | 0.1.21 |
| `MYCF711/magpie-trustoken-auth` | `magpie-trustoken-auth` | 0.3.23 |
| `MYCF711/magpie-magicrew-auth` | `magpie-magicrew-auth` | 0.3.71 |
| 本地 `magpie-wps-lingxi` | `@kevinfx/magpie-wps-lingxi` | 0.7.57 |
| `MYCF711/magpie-intern-ai` | `magpie-intern-ai` | 0.3.1 |
| `sabercomo/magpie-workbuddy-plus` | `magpie-workbuddy-plus` | 0.4.2 |
| `MYCF711/magpie-ima-local-auth` | `magpie-ima-local-auth` | 0.3.2 |
| `MYCF711/magpie-alysis-auth` | `magpie-alysis-auth` | 0.1.12 |
| `MYCF711/magpie-cnb-auth` | `magpie-cnb-auth` | 0.1.0 |
| 本地 `magpie-opc-auth` | `magpie-opc-auth` | 0.1.4 |

审计开始时配置还含 Accio 0.1.9；它在审计期间被另一个进程从启用配置与安装目录移除，
所以最终清单不计它。两个本地插件的最终工作树均为 clean；版本以最终复核为准。

## 2. 已有模块不重复造轮子

对 CNB、Alysis、OPC 与脚手架同名文件做了哈希比较。下列实现已在脚手架且有语义测试，
继续作为唯一基线，不从插件再抄一份：

- `openai-sse` 的分帧、UTF-8/CRLF 跨块、32 MiB 上限与非流折叠；
- `quota` 的窗口形状与路由约束、`usage-cache` 的按账号缓存；
- `model-context`、`models` 的上下文查询、价格与三态降级；
- `refresh-lock`、`oauth-pkce`、`request-rewrite`、`tool-schema`；
- `store`、`invite`、`account-name`；
- `local-browser`、`browser-login` 的现有浏览器基础（`desktop-import` 已于 0.2.0 删除：与「不读取桌面端」的边界冲突）；
- `rotation-captcha`、`vision-clock`、`tempmail-client`。

各插件的域名、UA、业务错误码、模型白名单、价格、签到任务、邀请默认值、组织/仓库选择、
WPS run 生命周期与 OPC API Key 换取都留在原插件，不进入通用层。

## 3. 本次择优回收

| 落点 | 来源 | 取舍 |
|---|---|---|
| `src/http.mjs` | CNB / OPC / WorkBuddy Plus | 回收共同 HTTP 外壳、保守 401/403 判定；Retry-After 只取纯函数，不搬自动重试 |
| `src/status.mjs` | Trustoken / Magicrew | 只读 400/422 clone；保守分类与安全 Response 改写；HTML 只留摘要 |
| `src/credential.mjs` | CNB / OPC | 只取凭据读取、指纹、种类优先级与 uid；厂商 shape/API/缓存不搬 |
| `src/oauth-device.mjs` | CNB（对照 Copilot / Alysis） | 选 RFC 8628 标准状态机；不选无总 deadline 或私有状态的轮询 |
| `src/checkin.mjs` | Raccoon | 用前后账单差集防重复上报；API、日期与业务过滤留调用方 |
| `src/stream-reader.mjs` | WPS | 超时只摘除等待者，不丢在飞数据块；不搬 WPS 续写策略 |
| `src/models.mjs` | Loomy / Alysis | 增加稳定 slug/code 映射与同 id 元数据合并；未知模型不继承第一条、不补回权限表 |
| `src/openai-sse.mjs` | Qoder | 只补无名 tool_call 收尾策略，不搬厂商 SSE |
| `src/store.mjs` / `src/invite.mjs` | WorkBuddy Plus | 独立临时名 + 0600/0700 + 原子替换 + 时区日键；邀请存储复用同一写原语 |
| `src/quota.mjs` | Intern InkStone | 无 zone 时间可按显式 offset 解析，消除宿主本地时区差异 |
| `src/usage-cache.mjs` | WPS | 合并 stale-while-revalidate 与原有按 key 缓存/单飞，旧失败值不冒充可用额度 |
| `index.mjs` | Magicrew | 复用现有 keyed lock 做签到 single-flight；不采用第二个调用直接 `done` 的 Set 版本 |
| `src/api.mjs` | CNB / Trustoken | 不再把任意 400/422 当模型 404，也不再把所有 403 当登录失效 |

## 4. 本次明确不回收

| 候选 | 原因 |
|---|---|
| Chromium LevelDB SSTable 解析 | 需要新增 Snappy 运行时依赖与二进制损坏夹具，独立批次处理 |
| 默认浏览器 Cookies / DPAPI 全流程 | OPC 新实现尚缺专属测试，不能未经验证直接变成模板底座 |
| JSON Schema 本地 `$ref` 展开 | 循环、深度与分支排序是独立大改，不能和本轮协议回收混在一起 |
| 非原生 tools 的文本提示词与流式协议 | 提示词、未知工具回退与模型行为需按上游验证，不能只抽成“通用”就发布 |
| 多模态图片描述后重试 | 涉及模型选择、自指、下载限制与副作用，暂不纳入低风险通用层 |
| 所有请求的传输自动重试 | POST 可能已到达上游；默认只应重试幂等请求，不能复制“一律重试两次” |

## 5. 复核方法

```bash
node --test
npm run check:template
npm run check:errors
npm pack --dry-run
node scripts/privacy-scan.mjs --staged
```

每次回收至少满足：两个真实插件出现同一问题或一个插件有明显更优边界、实现可去除厂商常量、
有离线语义测试、不会重复 magpie 宿主已有职责。
