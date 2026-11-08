# 安全策略 / Security Policy

## 支持范围

| 版本 | 是否接受安全报告 |
|---|---|
| 最新 tag（见仓库 `CHANGELOG.md` 顶部 / 本地 `git tag`） | ✅ |
| 上一个 minor 的最新 patch | ✅ |
| 更早的版本 | ❌ 请先升级 |

本仓库是**一个 provider 插件**（`magpie-phanthycode`），本身不含服务端、不上传用户数据。
但它持有第三方站点的登录态与本机设备私钥，所以下面这些都算安全问题：

- `src/` 里的凭据处理：`credential` / `store` / `refresh-lock` / `oauth*` / `http` /
  `device-key` / `proof` / `local-import` 的凭据泄露、日志脱敏缺失、并发刷新竞态、
  设备私钥落盘权限；
- `scripts/` 里的发布链路（`release` / `publish-npm` / `privacy-scan`）的供应链风险；
- 文档里给出的**错误示范**（照着 `HOOKS.md` / `README.md` 写会写出漏洞的那种）。

## 怎么报

**首选**：本仓库的 GitHub 私密报告入口（仓库 Settings → Code security →
Private vulnerability reporting；没有远端时用下一条）。

**其次**：在仓库里开一个 **security** 标签的 issue，只写「影响面 + 复现步骤」，
**不要贴 token / 手机号 / 本机路径**。

**别做的事**：不要在 issue 里贴能直接用的凭据；不要用真实账号做破坏性验证。

## 我们怎么处理

| 阶段 | 目标 |
|---|---|
| 确认收到 | 3 天内 |
| 给出影响判断（是否影响已发版本） | 7 天内 |
| 修复与发版 | 按 `UPDATING.md` 的受控发布流程，`CHANGELOG.md` 里标注 |

修完会做两件事：`CHANGELOG.md` 写清「影响哪个版本、怎么缓解」，
并在 `git tag` 里打一个新版本（插件更新靠版本号，不打 tag 用户拿不到）。

## 本仓库**不**接受的

- 需要先拿到用户设备上的私钥/凭据才能触发的「漏洞」；
- 纯上游（`code.phanthy.com`）服务端的问题 —— 请直接报给厂商；
- 依赖本机已登录的官方桌面端才能复现的问题（本插件不读取、不依赖它）。
