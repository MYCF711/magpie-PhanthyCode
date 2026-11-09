# AGENTS.md —— 给 AI 执行者的入口

> 人类请读 [README](./README.md)。这份只回答两件事：
> **你现在该读哪一份**，以及**忘了哪一条会静默出错**。
>
> 从本模板派生出去的插件仓库，请把这份一起带走 —— 下面每一条对派生仓库同样成立。

---

## 一、先定位你在哪一步

别从头读到尾。先看自己在哪一格，只读那一格指的文件。

| 你在做什么 | 必读（按顺序） | 做完的判据 |
|---|---|---|
| **还没开工**，手上只有一台 magpie | [GUIDE.md](./GUIDE.md)（30 分钟主线，每步带官方锚点）→ 本文件 → [README](./README.md) 的「现在能用什么」「两种登录方式」「三条 canonical」 | 能说清「哪些事 magpie 已经做了、插件不该重做」 |
| **决定要不要拆成两个供应商**（国内版 / 国际版） | [MULTI-PROVIDER.md](./MULTI-PROVIDER.md)（只有一个站点：跳过） | 两张卡、两组登录态，互不覆盖 |
| **填那五个 TODO / 改钩子** | [HOOKS.md](./HOOKS.md) —— **按钩子查章节，不要通读** | 每个钩子的返回值形状与 HOOKS 的对应章节一致（`config`/`loader`→六、`auth.checkin`→二、`auth.usage`→三、`auth.refresh`→五、`accountId`→八、图标→九之三、模型条目字段→十一之三） |
| **代码写完，准备交付** | [CHECKLIST.md](./CHECKLIST.md) 的 **A 表** | A 表全勾 + `node scripts/check.mjs` 退出 0 |
| **要发一个版本** | **[UPDATING.md](./UPDATING.md) 全文** | [CHECKLIST.md](./CHECKLIST.md) 的 **B 表**全勾 + 五条验证 |
| **用户说「有新版本但我这边没动静」** | UPDATING 的「一、magpie 怎么发现新版本」 | 分清是 npm 源（比 `version`）还是 git 源（比 HEAD commit） |

**最容易漏的是第 5 行。** 而且要记住分支和 `main` 是**两条分发通道**，不是「先放着」和「正式」：
- **分支 = 测试版通道**：用户写 `magpie plugin add owner/repo#feat-x` 才拿得到，不影响用 `main` 的人
- **`main` = 稳定版通道**：git 源跟随默认分支 HEAD，进了就是所有人

所以「怕把别人在用的插件炸了」的解法是**推分支**，不是「晚点推」。
PR 是 GitHub 对受保护分支的技术要求（直推报 `GH006`），批准数 0、自己就能合。

---

## 二、会静默出错的坑

「症状」列照着你看到的现象查；「判据」是正确做法；「出处」是完整论证。

| # | 症状（出问题时你看到什么） | 判据 | 出处 |
|---|---|---|---|
| 1 | 额度条永远是 100%；空账号反而排到队首 | `usage.used` **必填**且是有限数字 —— 它也是路由排序输入，漏了按 0% 算 | HOOKS 九 |
| 2 | 免费模型被反复派发；或收费模型被标成免费 | `free` 只认厂商自己的声明：列表价 $0，或厂商自己的计费端点明确说 0。**`rate: 0` 的意思是「没给倍率」，不是免费** —— magpie 不会从 `rate` 推 `free`（#468 更正，2026-10-29）。**价格是三态，不是两态**：缺价格 / `null` / 空对象 / `""` / 非法字符串 / 布尔 / 负数 → **不列这一条**（`Number(x) \|\| 0` 就是把「不知道」写成「免费」）；只有**显式 `0`** 才 `free: true`。反过来，把「套餐内不按次计费但吃额度」的模型标成 `free: true`，Free first 会一直派发它们。判据：`node --test tests/catalog.test.mjs` 退出 0 | HOOKS 十一之二 · `src/catalog.mjs` 的 `creditsOf` · `src/models.mjs` 的 `priceOf` |
| 3 | 点登录后界面转圈很久，或模型列表整个卡住 | `authorize()` 必须**立刻**返回；网络请求一律挪到 `loader` | `index.mjs` 顶部「三条铁律」第 2 条 |
| 4 | 刷新一次 token 后某个字段变空，或用户被要求重登 | `refresh` 返回的是**合并**结果，只给新字段会覆盖掉旧的 | `index.mjs` 顶部「三条铁律」第 3 条 |
| 5 | 插件装上了，但模型列表空、界面没反应 | `config.models` 必须有内容（可以是静态占位） | `index.mjs` 顶部「三条铁律」第 1 条 |
| 6 | 某一个模型报错，**整个账号（甚至所有账号）**被停用 | 模型级错误返回 **403 / 404**，不是 401。401 可重试 ⇒ 会 failover 到**每一个账号**，每个都标登录失效。magpie ≥ 0.1.1934（`3ec25523c`）起，插件 401 的 body 只说模型不可用、不提 token/key/sign-in/session 时不标账号；但插件仍应回 403/404（#468） | ERROR-CODES §2 · HOOKS 七 |
| 7 | 登录偶尔「莫名失效」，多账号同时刷新时更常见 | 一次性 `refresh_token` 必须**串行**（同账号同时只允许一次刷新） | `src/refresh-lock.mjs` |
| 8 | 流式输出卡住 / 只有第一段就结束 | 不要在 `fetch` 里读流，把 `Response` 原样交回去 | HOOKS 六 · `src/chat.mjs` |
| 9 | GitHub 把 license 标成 `NOASSERTION`，卡片上没有许可那一格 | `LICENSE` 最好写**逐字 MIT 正文**，归属说明另放 `NOTICE.md`。magpie ≥ 0.1.1934（`5957d45ac`）起，`NOASSERTION` 的 listing 回退到 `package.json` 的 `license` —— 夹归属说明不再必然没许可，但 GitHub 仍不认那份 LICENSE（#468） | README「现在能用什么」· `package.json` keywords |
| 10 | 改了代码重装，行为一点没变 | 同版本号重打包会命中 bun 缓存（`no changes`）—— 必须 bump `version` | UPDATING 第 1 步 |
| 11 | `magpie plugin add xxx.tgz` 跑完像成功，实际没装上 | 这个命令有 bug，改 `plugins.json` + `plugins/package.json` 两处 | HOOKS 十四 |
| 12 | 想让卡片标题/文案对，去改了 magpie 的缓存文件 | 插件对 magpie 的目录**只有读的份**；唯一载体是 `registry-entry.json` | README「不要写 magpie 的缓存」 |
| 13 | 用户那边没更新 / Release 页面是空的 / 「暂无发布版本」 | 起功能分支 → CHANGELOG + bump → 检查 / 测试 / pack → 推分支 → 提 PR 等 `rules` 绿 → 合并 → npm / tag / Release → 五条验证。**直接推 main 会被分支保护拒绝** | UPDATING 二 · CHECKLIST B |
| 14 | 整轮失败，但宿主既不换号也不退避，用户干等一个永远不会好的错误 | 每个错误出口都要 `status` + `code` + 有信息量的 `message`。三个高频错法：① 端点不存在用 **404**（宿主以为是模型坏了，把这个模型搁置）；② 超时/流截断落 **502**（不可重试，宿主不换号，用户只能一直撞墙）；③ `message` 只写「服务异常」，排查时无从下手。词表与模板见 `ERROR-CODES.md`，形态由 `npm run check` 卡门 | ERROR-CODES §2/§4 |

补充两条只在发布侧出现的：

| # | 症状 | 判据 | 出处 |
|---|---|---|---|
| 14 | 推了分支，magpie 还说没更新 | git 源比的是**默认分支** HEAD 的 commit；推别的分支不算。而 `plugin add` 不会更新已有的锁 | UPDATING 一 / 六 |
| 15 | magpie 的 Discover 里搜不到自己的包 | `keywords` 要含 `opencode` + `plugin`/`auth`/`provider` + `magpie`；仓库要打 `magpie-plugin` topic | README「现在能用什么」· `package.json` keywords |

再三条与代码结构有关的 —— 它们不报错，但会让插件在多账号 / 部分成功 / 长大后出问题：

| # | 症状 | 判据 | 出处 |
|---|---|---|---|
| 16 | 加了第二个账号，第一个账号的数据变了 / 串号 | 一切按账号落盘的东西，文件名必须带账号（`<plugin>-<siteId>__<account>.json`）；**不要用模块级变量存 per-account 状态** —— 宿主是同一个进程跑所有账号。设备记录的键是 `uidOf(auth)`（会变），**换键只能迁移那条记录**：按 `accountScope` **完全相等**找回，identity 公钥与 installationId 不动，**绝不按名字/作用域复制别人的私钥**。判据：`node --test tests/device-key.test.mjs tests/account-device.test.mjs` 退出 0 | `src/store.mjs` 的 `fileOf` · `src/device-key.mjs` 的 `adoptInstallationByScope` |
| 17 | 接口抖一下，列表整个空掉；或某个模型缺价格，用户选了报错 | **部分成功有三态**，方向要各自选对：① 整个接口失败 → 退回上次快照（不要返回空表）② 接口成功但单条缺字段（缺 id、缺价格、`null`、空对象、负数）→ **不列**（不猜，也**不补一个 0** —— 补 0 等于宣称免费，见坑 2）③ 登录失效 → 抛 `signIn: "expired"`。判据：`node --test tests/catalog.test.mjs tests/models-adapters.test.mjs` 退出 0 | [`src/models.mjs`](./src/models.mjs) 的 `buildModels` · `src/catalog.mjs` 的 `parseCatalog` |
| 18 | 越改越乱，`index.mjs` 涨到几百行，改一个钩子要读全篇 | 成熟形态是**`index.mjs` 只做九项钩子的装配，实现全在 `src/`**。实测四个真实插件的 `index.mjs` 是 80~715 行，而 `src/` 是 1.4k~3.7k 行 —— **本仓库同样是这个形态：`index.mjs` 只做九项装配（额度卡片已搬进 `src/usage-windows.mjs`），实现全在 `src/` 里**。模块数不写死在文字里（合并一次就变）：要看就 `ls src/*.mjs \| wc -l` | 本文件「五、长大之后」 |

还有一批是**后来的契约核对与真机实测**补出来的（最早一批起于 magpie 0.1.1763，2026-10-28；**39~43** 来自 0.1.1 的隔离浏览器 / 出站 origin / 设备身份收尾、CHANGELOG 门与 0.2.0 的邀请模式开关）：

| # | 症状 | 判据 | 出处 |
|---|---|---|---|
| 19 | 某个能力「明明实现了却没生效」：模型不会联网、不能收图、没有思考档、折扣前的倍率不显示 | 模型 / provider 条目上有一批**不写就等于关掉**的字段：`searches`（模型级=这条自己会搜，provider 级=上游整体会搜）、`decides`（decision 模型，从 agent 列表隐藏）、`rateWas`（折扣前倍率）、`fast`、`serviceTiers`、`modalities`（图片 / 音频能力全靠它；其中 `image` 省略 **≠** 关掉，见坑 25） | HOOKS 十一之三 |
| 20 | 厂商有画图模型，插件里当垃圾过滤掉了；或者反过来，列进去之后用户在 chat 里选中报 400 | magpie **0.1.1707 起**支持插件供图（`DrawsID` + `ImagesAPI` + npm 是 `@ai-sdk/openai-compatible`）。但它**同时**留在 chat 模型列表里 —— 列不列是取舍，判据见 [`src/models.mjs`](./src/models.mjs) 的 `LIST_IMAGE_MODELS` | HOOKS 十一之三的「插件供图」 |
| 21 | 花一晚上追 magpie 的「每个版本」，改了一堆文档，用户那边一点变化都没有 | **判断要不要同步，看稳定渠道**（magpie 设置里那个「更新渠道：每个版本 / 稳定版」）。`curl -s "https://usemagpie.ai/api/latest?channel=stable"` 拿稳定版版本号；2026-10-28 实测：每版本 0.1.1763 / **稳定版 0.1.1327**，逐字段比对后插件相关字段**完全一致** —— 追每版本几乎全是白跑。一条命令判断：`node scripts/check-magpie-stable.mjs` | HOOKS 顶部 · UPDATING 一 |
| 22 | 卡片上每个账号都显示「剩余额度未知」，而 `usage()` 明明返回了 plan / balance / windows、也没有 error | **窗口变成 text-only 了**：**判断只看 `used`，与 `aside` 无关**（#468 更正，2026-10-29）。两种写法会丢占比：① 有 `amount`/`limit` 却没有 `used`（magpie < 0.1.1934 直接丢；≥ `1390aa458` 才用 amount/limit 推算）② `resetsAt`/`runsOutAt` 塞厂商原样时间 `"2026-10-28 23:59:59"`（解析失败 ⇒ 整条丢）。判据：`curl -s http://127.0.0.1:3425/v1/magpie/quotas`，看 `windows[0]` 有没有 `text: true` 和 ISO 形式的 `runsOutAt` | HOOKS 三 · 三条「写错不报错」的窗口规矩 |
| 23 | 有一批额度快到期了，卡片上却完全看不出来 | 用官方字段 `runsOutAt` + `runsOut`（剩余额度何时作废、损失多少），**不要拼进 `display`** —— 拼进去只是普通文字，magpie 不会当失效提醒。厂商给的时间要先转 ISO | HOOKS 三 · 规矩 ③ |
| 24 | **卡片上额度正常，路由页里这个号却是「剩余额度未知」，还总排在别人后面** | 窗口没有被路由计入：**`used` 缺省的窗口判成 `Text`，`aside: true` 的窗口路由直接跳过** —— `w.Aside || w.Text` 两个条件都会跳过，与 amount/limit 无关（#468 更正）。一条不剩 ⇒ `allowanceOf()` 返回空 ⇒ `routedAllowance` 不 ok ⇒ `weighed()` 不设 `Known`。**「不参与排序」的实际后果是「这个号在路由里不存在」**。判据：`curl -s http://127.0.0.1:3425/v1/magpie/trace` 看这个 provider 的 `known` 是 `true` 还是**字段缺失**；`~/.config/magpie/quotas.json` 的 `spans` 是 `[{}]` 还是 `[{"aside":true}]` | HOOKS 三 · 规矩 ① |
| 25 | **模型明明收不了图，却被当成能收图**：截图直发上游报 `The request model is not multimodal` / 400，或者模型回「图片无法查看」 | 模型条目的 `capabilities.input.image` **必须写成布尔值**：省略不等于 text，等于「厂商未表态」，magpie 会拿 models.dev 的裸模型 id 投票补 —— 同名模型在别家标过 `image`，这个模型就会被带成能收图。text-only 模板见 HOOKS 十一之三；反向的手动覆盖（厂商说 `false` 却勾了 `Accepts images`）在 magpie 侧暂无警告 | HOOKS 十一之三 · CHECKLIST A-14 |
| 26 | 邀请码填了、主登录也过了，但上级没拿到奖励；或「邀请码」那条登录方式点开只有一个框、后面什么都没接 | 两个原因：① 与码成对的额外参数没带（Accio 的 `sId`）—— 换码时必须一起换，见 `src/invite.mjs` 的 `write()`；② 用 `prompts` 数组串「邀请码 → 主登录」是串不起来的，必须用 `ask()`（HOOKS 四·陷阱 5） | HOOKS 四·陷阱 5 · 四之二 · `src/invite.mjs` |
| 27 | **卡片上的账号名是一串看不懂的 ID**（`iam::01a1642a…:user:hw0615…`、`urn:…`、uuid），用户以为是「显示乱码」 | `accountId` 是**名字**，不是身份：手机号（`maskPhone` 对去掉国家码后 ≥11 位的号码打码 `138****8000`；短号返回空串不显示）→ 昵称/邮箱 → **空串**（宿主回退供应商名）。内部 ID 只进 `uid`。**URN 写进 `accountId` 极难改回** —— 续期返回值是合并、插件落盘又多保留旧值，所以续期路径也要重算一遍 | HOOKS 八的「`accountId` 是名字，`uid` 是身份」· `src/account-name.mjs` 的 `resolveAccount` |
| 28 | 卡片标题写 `华为云 HUAWEI` 之后，`magpie plugin update` 报 `unrecognised dependency format: 华为云 HUAWEI` | `package.json.name` 同时是 bun 依赖键，**必须是 slug、不能有空格**；显示名写 `package.json.magpie.name`（可带空格），provider/registry 同步。旧安装按 UPDATING 的「旧版带空格依赖键」改键 + 目录 + lock，不用 rm+add | README「包名是 slug；显示名写 magpie.name」· UPDATING 迁移 |
| 29 | 仓库里写了真手机号 / 邮箱 / 本机路径，把那次提交删掉就以为没事了 | **历史里那份还在**：`git log -p`、下载任意旧 commit 都能看到。提交前跑 `node scripts/privacy-scan.mjs`（0 = 干净）；已经 push 过的要 `git filter-repo --replace-text` 重写全部历史再强推，作者邮箱顺手换 `…@users.noreply.github.com`（`git log` 会聚合作者，真邮箱=公开 QQ 号/手机号）。**改前改后 `git rev-parse HEAD^{tree}` 必须一致** —— 一致才说明「用户装到的东西没变」，只是 SHA 变了 | 本文件「八、脱敏」 |
| 30 | 登录后额度正常、模型通道却空；或两种登录方式互相串凭据 | 凭据种类只按 **运行时缓存 → `metadata.kind` → 形状探测** 判断，不按 `auth.type` 猜；uid 取不到厂商 id 时用凭据指纹，不把 token 当账号名 | `src/credential.mjs` · `tests/credential.test.mjs` |
| 31 | 非流折叠后出现 `function.name: ""`，客户端保存了不可调用的工具 | 参数/id 可先到，但流末仍无名的 tool_call 必须丢弃；若整轮只有它就抛 `status=502 / nameless=true`，有文本或命名调用则保留原答案 | `src/openai-sse.mjs` · `tests/openai-sse.test.mjs` |
| 32 | 空闲超时后下一段首块消失；或额度接口一抖卡片就没数 | reader 超时只摘等待者，在飞块入队；usage 用 SWR 返回旧成功值并后台单飞，无旧值才做有界等待 | `src/stream-reader.mjs` · `src/usage-cache.mjs` |
| 33 | 同一条厂商时间在 CI 与本地差 8 小时 | 无 zone 时间先给显式 `offset` 再转 ISO；不能让 `Date.parse` 先按宿主本地时区吃掉；自带 Z/offset 不覆盖 | `src/quota.mjs` 的 `toIso` · `tests/semantics.test.mjs` |
| 34 | 登录补任务和每日签到撞在一起，重复领奖或重复上报；两个同名账号还串成一把锁 | 同账号 single-flight 共享同一 Promise，`replayMs:0` 不回放成功；key 用 uid/凭据指纹，**不用可重名的 accountId**；签到上报用前后账单差集，缺 before 时保守 `done`。**签到不要求「先发一次模型请求」**：设备未就绪时用户主动点签到 = 显式动作，按 `profile → register → activities → rewards → claim` 自己备好身份；注册失败**如实 `failed`**（带状态码/原因），绝不改写成 `claimed`，也不继续领奖 | `index.mjs` · `src/checkin.mjs` · `src/production-auth.mjs` 的 `ensureInstallationReady` |
| 35 | live 新模型继承了第一个模型的 1M 窗口/看图能力，或静态表把无权限模型补回来 | 只按相同 id 合并静态元数据；未知模型不猜，目录失败才回快照，live 缺项不补回 | `src/models.mjs` · `tests/models-adapters.test.mjs` |
| 36 | **卡片上的图标是个圆的**，四角露出深色底，和旁边别的插件不齐 | magpie 把图标画在**圆角方框**里；官网 favicon 常是「品牌徽标」，WorkBuddy 那份 `logo.svg` 里 `rect rx="20"`（40 宽画布）就是正圆。真正的**应用图标**在客户端安装包里 —— Windows exe 的 PE 资源 `RT_ICON` 存着 16~256 多档 PNG，256 那档拖出来就是官方原图：`node scripts/app-icon.mjs <installer.exe> --data-uri`。判据：**别只看 favicon**；两处都要写（`auth.icon` 与 `package.json` 的 `magpie.icon`，见 HOOKS 九之三） | `scripts/app-icon.mjs` · HOOKS 九之三 |
| 37 | **插件里的模型比厂商网页上少几个，或者倍率 / 上下文不对** | 厂商常有**两份目录**：客户端读的那份（如 `/v3/config`）更新慢，控制台 / 网页那份带完整的分角色元数据。用 [`src/catalog-union.mjs`](./src/catalog-union.mjs) 合并：控制台那份作**主目录**（同 id 用它），配置那份补它没有的 id 和促销表；`auto` / 补全 / 过小输出 / 生成图这些非聊天行过滤掉。**两份都读不到要抛**（调用方回退上次快照），返回 `[]` 会被宿主当成「这家没有模型」 | `src/catalog-union.mjs` · 本文件坑 17 |
| 38 | **上游偶发或固定回 403 `TM.00000001`（文案是「网络繁忙，请稍后重试」），重试和换账号都没用**；或者某个 provider 换到新网络 / 新账号后就不通 | 每个打上游的 `fetch` 都**显式**带 `User-Agent`，值是**该服务官方客户端**的 UA —— 绝不写 `<包名>/<版本号>`，也绝不让宿主的 `magpie/<version>` 透传（插件不设 UA 时它就这么上去）。官方是网页就用完整 Chrome UA；有 App / CLI 客户端就用那个客户端的 UA。判据：`node scripts/check-ua.mjs .` 退出 0。注意 `npm run check` 对「每个打上游的文件是否显式带 UA」只给**警告**（静态拼不出的算不出来），别把警告当门 | `src/http.mjs` 的 `OFFICIAL_UA` · `scripts/check-ua.mjs` |
| 39 | 请求**成功**、日志干净，但用户从此收不到额度 —— 某处把绝对 URL 原样转发（或上游回了个 URL），**账号的 access token 发到了别的主机** | 出站 URL 一律过 `src/origin.mjs` 的 `trustedUrlOf`：① protocol 必须 `https` ② origin 与 `src/context.mjs` 的 `BASE` **逐字相等**（`code.phanthy.com.evil.com` / `evil.phanthy.com` / 非默认端口全部拒）③ 不许 userinfo ④ 相对路径只能单个 `/` 开头（`//host/x` 是协议相对、反斜杠有分隔符语义，都拒），错误信息里**不回显 userinfo**。数据面与 loader 共用这一个闸门。判据：`node --test tests/origin.test.mjs` 退出 0 | `src/origin.mjs` · `tests/origin.test.mjs` |
| 40 | 点「+」加新号，结果**直接进了旧账号**（授权页用了日常浏览器的会话），用户以为加了新号；或者反过来：**没装 Chromium 的人点加号什么都没有** | 默认 OAuth 每次登录开**一次性** `user-data-dir`（`mkdtemp` 落在系统临时目录）：不读 / 不复制 / 不删日常 profile，不带扩展，不开调试端口；callback 的 finally 只关**本次**进程、只删**本次**目录（失败 / 取消 / 超时同样先清垃圾）。临时目录一旦指向日常 profile 就拒绝启动，且绝不删那个目录。**开不出来不是登录失败**：没浏览器 / 启动报错 / 单实例浏览器接管参数时一律退回 `{url, opened:false}` 交给宿主的默认浏览器。**进程起来过 ≠ profile 被用上**：启动后要等 `<user-data-dir>/Local State` 出现，等不到按启动失败处理（否则单实例浏览器会把日常会话带进来）。**删不掉不许谎报**：`removedDir` 只在真删掉时为 `true`，失败要在下次 close 重试 —— 那个目录里是一份已登录会话。同理，**被 await 的定时器不能 `unref`**（Linux 上会让 `Promise resolution is still pending but the event loop has already resolved`）。判据：`node --test tests/isolated-login.test.mjs` 退出 0（含并发隔离、启动后校验、删失败重试三条） | `src/isolated-login.mjs` · `tests/isolated-login.test.mjs` |
| 41 | 同一个号**每刷新一次 token 就变成一台新设备**：卡片上额度窗口重复、服务端攒一堆孤儿安装记录 | api 型登录态 magpie 只持久化 `{type, key, metadata}` —— 稳定身份**只能**写 `metadata.userId`（= `fingerprint(accountScope)`）与 `metadata.accountScope`，且 `refresh` 必须**合并**返回（只给 `{email}` 会把它们冲掉 ⇒ 又退回「凭据指纹」）。登录成功即**纯本地**分配/复用它自己的三把密钥（零请求）；旧记录按**完全相同**的 scope 迁移，identity 公钥与 installationId 不动；不同 uuid 各自独立。判据：`node --test tests/account-device.test.mjs tests/credential.test.mjs` 退出 0 | `src/credential.mjs` 的 `metadataWithIdentity` / `accountScopeOf` · `src/device-key.mjs` 的 `adoptInstallationByScope` |
| 42 | 发版了、CI 全绿，**Release 正文却是空的**，用户看不到这次改了什么 —— 因为 `version` 已经 bump，CHANGELOG 却还没写这一节 | 门 ⑧ 的判据是**段首标题** `## <version>`，**不是正文子串**：正文里 `magpie ≥ 0.1.1763` 含「0.1.1」，会把根本没写的 0.1.1 蒙成绿（旧实现 `chg.includes(version)` 就这么漏的）。另外版本号要按**字面量**比对（`.` 必须转义）并带**右边界**：`## 0.1.1` 不许替 `## 0.1.10` 或 `## 0.1x1` 过关。判据：`node --test tests/check-version.test.mjs` 退出 0（5 条：真标题通过 / 正文子串失败 / 前缀 / 转义 / 带后缀版本各自只认自己） | `scripts/check.mjs` 的门 ⑧ `changelogHasVersion` · `tests/check-version.test.mjs` |
| 43 | **邀请源选错了人**：给新号注册时挂到了错误的账号下 —— ① **账号源优先级写反**（该用首选时用了最新、该用最新时用了首选）；② **首选没码时静默换了别的账号**（用户以为「没带邀请」，实际挂到了别人名下）；③ 在 `authorize()` 里取码或抓分享页（点登录转圈很久、甚至死锁）；④ 把 `accountId` 当邀请源键（同一个人换一次 token 就变成两个人，缓存各写一份，界面一切正常） | 四句判据缺一不可：① **源优先级**：`invite_mode` 关 = **最新注册账号**（`firstSeenAt` 降序，**只写一次**；最新没码 / `eligible === false` 才往前退），开 = **magpie 首选账号**（`logins.json` 的 `first: true` → 最小正 `order` → 第一行，`home` 再进 `plugin-auth.json` 取 `metadata.userId`）；首选没码 / 没资格 / 未设置 → **只**回退预留码，**绝不静默换号**。② **键必须是 uid**：`metadata.userId`（= `fingerprint(accountScope)`）；`accountId` 是显示名（可重名 / 可改名 / 重登会变），拿它当键 = 换 token 换人。③ **出站只在 `ask()`**：分享页 `/r/<code>` 至多抓一次，`authorize()` 里**零网络**（铁律 2 要它立刻返回）；失败回退裸授权 URL、**不阻塞登录**。④ **采集只在 usage / checkin**：设备已注册、每账号 24h 至多一次、先查资格（`GET /referrals/me`，**永远没有码**）再取码（`POST /referrals/code` + 幂等键 + v1 签名）；失败只降级，不影响额度 / 签到。另外：`auth.options[]` 只认**字符串** `placement: "top"` —— `top: true` / `placement: true` / `"bottom"` 全被归一化成 `undefined`；顶部摆放要 magpie **≥ 0.1.2985**（旧版忽略、不报错、回退底部，**不要**在插件里做版本硬判断）；它是 **provider 级策略，不是登录方式**，别新增 `auth.methods[]`，也别在工厂构造时读一次就缓存（切换开关不重跑工厂）。`referral_state` 必须挂在 **`/login` 顶层**（`/login?next=<授权URL>&referral_state=rs1.…`），写到 `/oauth/authorize` 上只会被折进 `next`。老账号**不能补绑**（409 是协议事实，不重试），登录路径**不调** `referrals/bind`。判据：`node --test tests/invite-mode.test.mjs tests/invite-wire.test.mjs tests/invite-source.test.mjs tests/referrals.test.mjs tests/preferred.test.mjs tests/invite-protocol.test.mjs` 退出 0（含源优先级、首选没码不换号、`placement` 归一化、`next` 解出来逐字等于授权 URL、整个登录流程零 `referrals` 写请求） | HOOKS 四之一 · `index.mjs` 的 `auth.options` / `resolveInviteSource` / `inviteLoginOf` · `src/invite-source.mjs` 的 `resolve` · `src/preferred.mjs` 的 `readPreferredUid` · `src/referrals.mjs` 的 `fetchReferralCode` |

---

## 三、命令

```bash
# 合规检查 —— 退出码非 0 就是不合规，别靠眼睛看
node scripts/check.mjs              # 检查当前目录（严格：占位符会失败）
node scripts/check.mjs ../my-plugin # 检查别的仓库
npm run check:template              # 仅脚手架自身：允许「未命名」占位符

# 出站 User-Agent —— 0 = 合规，2 = 有违规（打印 文件:行 + 值 + 修法）
#   上游按 `<product>/<version>` 认「第三方客户端」回 403 TM.00000001（文案是「网络繁忙」）；
#   而插件不显式设 UA 时，宿主会把 `magpie/<version>` 原样透传上去。坑表第 38 条。
node scripts/check-ua.mjs .
node scripts/check-ua.mjs ../my-plugin

# 打包面预演：README / CHANGELOG / docs 在不在包里
npm pack --dry-run

# 包名撞车检查（撞了 = magpie 的「更新」会装成别人的包）
npm view <包名> version

# 语义测试 —— check 查「形状」，它查「语义」（free 三分支 / 三态降级 / 404 vs 401 / 流式 usage）
node --test

# 维护检查 —— 改了代码有没有 bump、bump 了有没有打 tag、CHANGELOG 有没有这一节
#   六条全不报错，但后果同一个：用户永远拿不到新版。发布前必跑。
node scripts/check-maintenance.mjs

# action 版本 —— 本仓库不装依赖机器人，这件事写在协议里
#   平台上的依赖机器人只扫 .github/workflows/**，**扫不到 .github/actions/*/action.yml**
#   里的 uses —— 而这条恰好是复合 action 自己的运行时依赖。
#   0 = 都在最新 major；2 = 有落后（打印 文件:行号）；1 = 查不到（网络 / 限流：等于没判断，不是「没问题」）
GITHUB_TOKEN=$(gh auth token) node scripts/check-actions.mjs

# 显示名（magpie.name，中文 + English）与 npm 包名不同时发布
#   本仓库自带 scripts/publish-npm.mjs（PUBLISH_AS = magpie-phanthycode）；
#   显示名与 npm 名不同时由它临时换名，发布完恢复。
#   release.mjs 会自动检测：有它就用它，没有就退回 npm publish。
#   CI 的 release.yml 必须配 NPM_TOKEN；没配会显式失败（不是 exit 0 假绿）。
npm run publish:npm

# 受控发布：只在 PR 合并后运行；脚本不推 main，只推 tag
node scripts/release.mjs             # 预演：已合并 HEAD + 检查 / 测试 / pack，什么都不改
node scripts/release.mjs --yes       # 真做：tag + Release（要 GITHUB_TOKEN 才建 Release）
node scripts/release.mjs --yes --npm # 再加 npm publish

# 手工版（release.mjs 用不了时）
git tag v0.1.8 && git push origin v0.1.8

# 重新提取 magpie 二进制里的钩子契约（核对 HOOKS.md 用）
python extract-contract.py [magpie 可执行文件]

# magpie 升级后必做：重新提取 + 自动找出 HOOKS.md 漏写的字段
python extract-contract.py && node scripts/contract-diff.mjs
#   退出码 2 = 有差集（列出前 40 个）。挑「不写会关掉某个能力」的补进 HOOKS 十一之三。

# 该不该跟着 magpie 升级动这份文档？**看稳定渠道，不看每版本渠道**
node scripts/check-magpie-stable.mjs
#   0 = 基线就是当前稳定版，不用动；2 = 稳定版变了，按它打印的三步走
#   裸查：curl -s "https://usemagpie.ai/api/latest?channel=stable"

# 模型「说自己能收图」是不是真的？发一张写着字的内嵌图问它，按回答分四类
#   假声明 = magpie 当它能收图、直发上游，而上游答「看不见」或直接拒绝（坑 25）
node scripts/probe-vision.mjs                 # 测网关 /v1/models 里的每个模型
node scripts/probe-vision.mjs --vision-only   # 只测设置里那个识图模型
node scripts/probe-vision.mjs <provider/model> …
#   退出码 2 = 有假声明；只读本机网关与 settings.json，不改任何配置

# 卡片图标：厂商官网的 favicon 多半是圆形品牌徽标，magpie 画在圆角方框里会四角留空（坑 36）
#   真正的应用图标在客户端安装包里（Windows exe 的 PE 资源 RT_ICON）
node scripts/app-icon.mjs <installer.exe>                # 列出包里的图标尺寸
node scripts/app-icon.mjs <installer.exe> --data-uri     # 直接出 magpie 的 icon 字段值
node scripts/app-icon.mjs <installer.exe> --size 256 --out icon.png
#   只认 PNG 编码的图标（老式 BMP 图标不处理，退出码 2）；
#   走的是资源树不是 PNG 签名，所以不会把安装包的界面插图当成图标
```

---

## 四、两个交付门

**门 1 · 代码交付**（给用户能装之前）

```
□ node scripts/check.mjs 退出码 = 0
□ CHECKLIST.md 的 A 表全勾（check 脚本查不到的那部分）
□ 五个 TODO 的语义按 HOOKS.md 对过一遍，不是「能跑就算」
```

**门 2 · 发布**（说「已发布」之前）

```
□ CHECKLIST.md 的 B 表全勾
□ 五条验证都跑过（含 check-maintenance.mjs）：npm 版本 / tarball 内容 / 本机 magpie 认得 / Release 在
```

⚠ **没过门 2 不许说「已发布」。** 只 push 过就说已发布，是在用印象代替验证。

---

## 五、长大之后：从单文件到 `src/`

本模板刻意是**单文件入门**（九个钩子一屏读完，五个 TODO 在底部）。但插件一旦有登录、
缓存、多账号、签到…就会长。四个真实插件的实测形态是这样：

| 仓库 | `index.mjs` | `src/` | `tests/` |
|---|---|---|---|
| 本仓库 | 只做装配（见坑 18，行数不抄） | 看 `ls src/*.mjs` | 看 `ls tests/*.test.mjs` |
| `magpie-magicrew-auth` | **86** | 27 文件 / 7,773 行 | 17 |
| `magpie-officeace` | 383 | 8 文件 / 1,566 行 | 2 |
| `magpie-loomy-auth` | 611 | 9 文件 / 1,905 行 | 4 |
| `magpie-today` | 715 | 18 文件 / 2,812 行 | 7 |

结论：**`index.mjs` 只做装配，实现全在 `src/`** —— 最成熟的那个（magicrew）index 只有 86 行。

`src/` 已经备好一批模块（**数量不写死**，看 `ls src/*.mjs`；前四块四个插件里 4/4 都有；其余来自社区与当前真实启用插件的择优回收，
2026-11-03 的 17 项启用清单、哈希对照与排除边界见 [RECYCLING.md](./RECYCLING.md)）：

| 文件 | 里面写什么 | 为什么单独拎出来 |
|---|---|---|
| [`src/http.mjs`](./src/http.mjs) | `CODES` / `errorResponse` / `errorText` / `retryAfter` / `isLoginBroken` | 统一错误出口与保守登录失效判定；401 模型错误、403 权限/WAF 不杀账号 |
| [`src/status.mjs`](./src/status.mjs) | `classifyRefusal` / `rewriteRefusal` / `upstreamText` | 只读 400/422 clone；超时→504、暂不可用→503，余额/渠道/模型/限流各自分流；SSE 与 schema 原样放行 |
| [`src/credential.mjs`](./src/credential.mjs) | `rawCredentialOf` / `fingerprint` / `credentialKindOf` / `uidOf` | 凭据种类只看 cached → metadata → shape；厂商 shape/API 注入，不进通用层 |
| [`src/oauth-device.mjs`](./src/oauth-device.mjs) | `requestDeviceCode` / `pollDeviceToken` / `refreshAccessToken` | RFC 8628 标准设备码状态机；slow_down +5 秒、总 deadline、abort、刷新不误判失效 |
| [`src/checkin.mjs`](./src/checkin.mjs) | `billKey` / `isPositiveGrant` / `reconcileCheckin` | 前后账单差集区分 claimed/done；缺 before 保守，不重复计算一次性奖励 |
| [`src/stream-reader.mjs`](./src/stream-reader.mjs) | `createStreamReader` / `read` / `cancel` | 空闲超时不取消在飞 read、不丢迟到块；done/error 重放且只在有等待者时拉取 |
| [`src/refresh-lock.mjs`](./src/refresh-lock.mjs) | `createRefreshLock` / `run` / `clear` / `sweep` | 一次性 refresh_token 的并发闸：同 key 合并、成功回放 60 秒、失败可重试；键必须是凭据身份 |
| [`src/oauth-pkce.mjs`](./src/oauth-pkce.mjs) | `generatePkce` / `randomState` / `startLoopback` | OAuth PKCE S256 + 127.0.0.1 loopback：state/Host 校验、错误 path 404 不结束、错误 state 400 可重试、超时/abort/close |
| [`src/model-context.mjs`](./src/model-context.mjs) | `createModelContext` / `contextOf` / `clear` / `size` | 查 `~/.cache/magpie/models.json` 的真实上下文；查不到返回 fallback / undefined，不猜 |
| [`src/openai-sse.mjs`](./src/openai-sse.mjs) | `parseSse` / `readSseEvents` / `openAIEvents` / `foldOpenAI` | SSE 帧解析 + 非流折叠；CRLF / 多行 data / BOM / UTF-8 跨块 / 32 MiB / tool_calls 分片 / usage 帧 |
| [`src/usage-cache.mjs`](./src/usage-cache.mjs) | `createUsageCache` / `read` / `readSWR` / `publicUsage` / `exhausted` | 成功 60 秒 / 失败 5 秒；stale 立即返回 + 后台单飞，无旧值有界等待；无读数时 `exhausted` 放行 |
| [`src/request-rewrite.mjs`](./src/request-rewrite.mjs) | `rewriteJsonBody` / `ensureStreamUsage` / `clampMaxTokens` / `stripModelPrefix` / `stripHopHeaders` | identity 快路径；改 body 后必须去掉 `content-length` / `content-encoding`；工具 schema 不动 |
| [`src/tool-schema.mjs`](./src/tool-schema.mjs) | `truncateToolName` / `truncateToolNames` / `loosenToolSchema` / `adaptToolList` / `rewriteToolSchema` / `createToolSchemaAdapter` | 工具名超长截断（保持唯一）+ 工具 schema 兼容改写（`additionalProperties` 非布尔→`true`、删 `items:{}`、`items` 子树摊平且不留空 `{}`）；**默认关闭、只作显式 adapter** —— 会放宽用户 schema，与 `request-rewrite.mjs` 的「工具 schema 绝不改」是两套取舍，别同时挂 |
| [`src/api.mjs`](./src/api.mjs) | `headersFor` / `read` / `get` / `asModelError` / `asSignInExpired` | 错误语义只在一处定义 —— 401 与 404 混用会打死整个账号 |
| [`src/models.mjs`](./src/models.mjs) | `buildModels` / `assignSlugs` / `upstreamModelId` / `mergeModelMetadata` | 三态降级 + slug/code 映射；只按同 id 继承元数据，未知模型不猜、不补回权限表 |
| [`src/chat.mjs`](./src/chat.mjs) | `passThrough` / `withUsage` / `singleShotToSSE` / `normalizeUsage` | 流式三坑：读干流、漏 `include_usage`、`stream:false` 不被接受 |
| [`src/store.mjs`](./src/store.mjs) | `fileOf` / `readJson` / `writeJson` / `calendar` + 快照 / 登录态 / 标记 | 只写 `~/.cache/magpie`；独立临时名 + 0600/0700 + 原子替换；日键按厂商时区 |
| [`src/quota.mjs`](./src/quota.mjs) | `usageWindow` / `usage` / `toIso` / `QuotaShapeError` | **把「写错不报错、但 GUI 和智能路由会坏」的五类窗口写法变成运行时错误** —— 见下方的表 |
| [`src/invite.mjs`](./src/invite.mjs) | `createInviteStore` / `inviteHint` / `resolveInvite` / `makeInviteMethod` + 协议层 `INVITE_LOGIN_PATH` / `INVITE_SHARE_PREFIX` / `INVITE_FETCH_TIMEOUT_MS` / `buildInviteLoginUrl` / `parseReferralState` / `referralShareUrl` / `fetchReferralState` / `inviteModeOf` / `InvalidReferralCodeError` | 邀请码只能在登录 URL 上带、事后补不了；而 `prompts` 是静态数组，串不起「填码 → 主登录」—— 只有 `ask()` 能。协议层只做一件事：把授权 URL 包进 **`/login?next=…&referral_state=…`**（`referral_state` 从公开分享页 `/r/<code>` 现取：匿名、同 origin、官方 UA、10s、失败只回 `{state, reason}` 降级），**永不**调 `referrals/bind` / `referrals/code`，也**不读** `referrals/me` / `relations` |
| [`src/referrals.mjs`](./src/referrals.mjs) | `fetchReferralMe` / `fetchReferralCode` / `readReferralMe` / `readReferralCode` / `pickPrimarySlot` / `classifyReferralError` / `trustedShareUrl` / `isDeviceRegistered` | 「账号自己的邀请链接」：`GET /referrals/me` **只给资格、永远没有码**；`POST /referrals/code` 是唯一取码入口（body 字面量 `{}` + 幂等键 `referral-code:<installationId>:<ms>` + v1 签名）。不 bind、不重试、不碰推理端点、不抓 `/r/<code>`、不把码写进错误文案 |
| [`src/invite-source.mjs`](./src/invite-source.mjs) | `createInviteSourceStore` / `parseInviteShareCode` / `preferredHome` / `SOURCE_REASONS` | 邀请源策略 + 本地缓存：off = `firstSeenAt` 降序里第一个「有码且 `eligible !== false`」的账号（→ 预留 → 裸登录）；on = 首选 uid 的码（没码 / 死号 / 未知 → **只**回退预留）。键是 **uid**，不是 `accountId`；`firstSeenAt` **只写一次**（重登旧号不抢「最新」）；预留文件只读、**永不**被自动派生覆盖 |
| [`src/preferred.mjs`](./src/preferred.mjs) | `readPreferredUid` / `pickPreferredRow` / `uidFromAuthEntry` / `PREFERRED_REASONS` | 「magpie 首选账号」的只读解析（0.1.3371 没有插件声明式账号下拉框）：`logins.json` 的 `first: true` → 最小正 `order` → 第一行，`home` 再进 `plugin-auth.json` 取 `metadata.userId`。只读身份与选择字段，**绝不读** token；读不到就回退预留（不静默换人），任何输入都不抛 |
| ~~`src/desktop-import.mjs`~~ | 曾用于「从本机 Electron 客户端导入登录态」 | **已删除**（0.2.0，审计 F11）：本插件明确不读取桌面端凭据，这个模块 0 引用 0 测试，与插件边界直接冲突 |
| [`src/account-name.mjs`](./src/account-name.mjs) | `maskPhone` / `looksLikeIdentifier` / `accountLabelOf` / `resolveAccountLabel` / `resolveAccount` | 换码响应没有账号名 ⇒ 卡片只能显示「Signed in」；补一次 userinfo 就行，但**失败不能阻塞登录、不能编造**。手机号（去掉国家码后 ≥11 位）一律打码，短号返回空串；内部 ID（`iam::…` / URN / uuid / `hw…`）**不许当名字** —— 它们进 `uid`，名字取不到就是空串 |
| [`src/rotation-captcha.mjs`](./src/rotation-captcha.mjs) | `encodeAngle` / `createRotationCaptcha` / `solveRotationCaptcha` / `createCookieJar` | 「旋转图片对正」的验证码：角度编码是从前端反出来的（实测 4 组提交正向穷举唯一命中）；`acw_tc` WAF cookie 不带回去会回「客户端信息不匹配」；判角不可信要换图而不是硬撞 |
| [`src/vision-clock.mjs`](./src/vision-clock.mjs) | `readVisionModel` / `decideDegFromImage` / `clockToDeg` / `clockSpread` | 用用户自己在 magpie 里选的识图模型判「主体朝几点」；两个判官并行 + 分歧阈值；`max_tokens` 是给推理留的（400 会饿死答案） |
| [`src/local-browser.mjs`](./src/local-browser.mjs) | `readLocalCreds` / `credsNear` / `leveldbText` | 用户在自己浏览器里登录过时，直接读 localStorage 的 leveldb —— 不开窗、不弹浏览器；跨 origin 必须截断，否则 A 站 jwt 会配到 B 站 org |
| [`src/browser-login.mjs`](./src/browser-login.mjs) | `browserCandidates` / `findBrowser` / `chromiumLogin` / `selectCookies` | 需要用户在网页里登录时，开一个一次性 Chromium profile 从 CDP 取 Cookie；国产浏览器也要覆盖，Windows 注册表 App Paths 优先 |
| [`src/tempmail-client.mjs`](./src/tempmail-client.mjs) | `createTempMailbox` / `waitTempCode` | 邮箱验证码自动登录的一次性地址；域名有黑名单（`maxxspace.com` 被 magicrew 拒），换厂商先用真实请求确认 |
| [`src/catalog-union.mjs`](./src/catalog-union.mjs) | `catalogRows` / `isChatLike` / `mergeCatalogs` | 厂商有两份模型目录（客户端配置 + 控制台）时：控制台那份作主目录（元数据新），配置文件补 id 和促销表；非聊天行过滤掉；两份都读不到要抛 —— 返回 `[]` 会被当成「这家没有模型」（坑 37） |
| [`tests/semantics.test.mjs`](./tests/semantics.test.mjs) | 语义锁（含额度窗口 / accountId 规则） | `check.mjs` 查不到的那部分，只有它能拦 |
| [`tests/mount.test.mjs`](./tests/mount.test.mjs) | 入口唯一函数导出 / 九钩子 / config 模型 / loader / usage 形状 | 模块测试全绿也拦不住「index 改坏了」 |

**为什么 `src/quota.mjs` 值得单独一个文件**：额度窗口是 magpie **画卡片**和**智能路由排序**的同一个输入。
写错不会崩，只会让卡片显示「剩余额度未知」、让这个号在路由里被当成不存在 —— 用户以为插件坏了，
插件作者在日志里什么都看不到。这个构造器把五类写法直接变成 throw：

| 写法 | 不拦的后果 | 构造器的行为 |
|---|---|---|
| 缺 `used`（且没有 amount/limit） | 窗口判成 `Text`，**路由不计入** ⇒ 一条不剩时该号在路由里不存在（坑 24） | 抛，要 text-only 必须显式 `textOnly: true` |
| `aside: true` 又给 `amount`/`limit` | 分母就是余额本身，算出来永远「剩余 100%」—— 看着漂亮、含义是错的 | 抛 |
| 钱包型（`balance`）又给 `used` | 被当占比读，余额显示错 | 抛 |
| `resetsAt` 塞厂商原样时间 | 解析失败，整条窗口被丢掉（坑 22） | 抛 |
| 所有窗口都是 `aside` / `textOnly` | 路由一条都不读 ⇒ 这个号在路由页「剩余额度未知」且排在已知账号之后 | `usage()` 抛 |
| `span` 不是正整数 | 窗口长度算错，重置时间显示乱 | 抛 |

**拆分示例**：[`examples/split/`](./examples/split/) 把「index 只装配」这件事摆了一遍
（三个钩子各占一个文件 + 一个 40 行的 index）。钩子只有三种形态，其余五个照同一规则搬。

**什么时候该搬**（出现任一情形就搬，别等）：

- 某个钩子函数超过 60 行，或同一个 `fetch` 在三个钩子里重复出现 → 抽 `src/api.mjs`
- 需要在两次调用之间记住东西（token、快照、当天做过的标记）→ 加 `src/store.mjs`，
  **文件名里必须带账号**（坑 16）
- 开始有第二个账号进来 → 先查有没有模块级变量在存 per-account 状态

---

## 六、文档地图

| 文件 | 管什么 | 什么时候读 |
|---|---|---|
| [GUIDE](./GUIDE.md) | **说明书主线**：30 分钟，拿模板 → 改身份 → config → auth → models → usage/checkin → 自检 → 打分 → 发布 | **第一次做插件时，从头读** |
| [RECYCLING](./RECYCLING.md) | 真实启用插件清单、通用代码来源、已有模块哈希对照与回收/排除边界 | 要从另一个插件搬代码进模板时先读 |
| [OFFICIAL-SOURCES](./OFFICIAL-SOURCES.md) | **官方 22 个锚点 → 本仓库的映射**；每条结论的官方出处 + 版本基线 + 我们补的 8 条 | 想知道「这条规矩官方有没有写」时 |
| [SCORING](./SCORING.md) | 100 分怎么算、80 分卡在哪、`node scripts/score.mjs` | 交付前自评时 |
| [README](./README.md) | 这个模板的设计原则：最小交付面、九项清单、三条铁律、常见坑 | 开工前 |
| [HOOKS.md](./HOOKS.md) | 14 章钩子契约（**字段级**：少写/写错会怎样。官方文档讲行为，两者并用；`auth.checkin` 已于 v0.1.1582 补进官方文档） | 写代码时按钩子查 |
| [MULTI-PROVIDER.md](./MULTI-PROVIDER.md) | 一个包两个供应商（国内/国际）：判据、骨架、五条铁律 | 只有多站点时 |
| [UPDATING.md](./UPDATING.md) | 功能分支 + PR + `rules` 门禁、进 main 后的受控发布、用户怎么拿到 | **每次发布前** |
| [README-TEMPLATE.md](./README-TEMPLATE.md) | 插件介绍页模板（用户只看它决定装不装） | 写 README 时 |
| [CHECKLIST.md](./CHECKLIST.md) | 两张勾选表：交付前 / 发版前 | 两个交付门 |
| [CHANGELOG.md](./CHANGELOG.md) | 本模板自己的更新记录（格式即范例） | 找「为什么这样改」 |

---

## 七、这份文件的维护规矩

1. **任何一份专档新增/改写一条「会静默出错」的结论，就在第二节加一行**（症状 → 判据 → 出处）。
   不加的后果：这份表会慢慢过期，而 AI 会照样信它。
2. 第二节只放一句话判据，**论证留在出处那一份**。别在这里复制长段落 —— 两份会打架。
3. 新增一份文档，就要在第五节加一行，并说明「什么时候读」。
4. 判据要能**当场验证**（能跑的命令、能看的字段）。写不成判据的，是感想，不是规矩。

---

## 八、脱敏：公开仓库前必须做

> **公开仓库 = 永久。** 把带真手机号的那次提交 `git rm` 掉、或者「下次提交里删掉」都不算数 ——
> 历史里那份还在，任何人 `git log -p`、下载任意旧 commit、`git show <sha>:file` 都能看到。
> 这一节是 2026-11-02 全量清理 31 个仓库后立的规矩：那次 16 个仓库、214 个文件命中。

### 8.1 必须脱的（按后果排序）

| 类 | 例子 | 为什么必须 |
|---|---|---|
| **真凭证** | `ghp_…` / `sk-…` / `eyJ…` JWT / 私钥 / 带值的 `Cookie` | 等于账号被人用；**公开即视为已泄露，只能轮换**，删掉不算 |
| **个人身份** | 手机号（含 `+86 189 7009 8051` 这种空格写法）、邮箱、QQ / 微信号 | 会被爬；**协作者提交里也有别人的 PII**，一并处理 |
| **内网 / 本机** | `192.168.x.x`、`10.x.x.x`、`C:\Users\<登录名>`（含 `ADMINI~1` 短名、`/c/Users/…`）、自己起的密钥目录（`D:\<密钥目录>`） | 机器指纹 + 内网拓扑 |
| **业务敏感** | 上游账号 `user_id`、未公开的接口地址 / 封顶 / 倍率 | 商业信息 |

**不用脱的**：相对路径、产品约定的端口（19499 / 8188）、示例域名（`example.com`、`a@b.co`）、
已经打码的串（`138****8000`）。这些在文末的 `ALLOW` / `MAIL_OK` 里放行。

### 8.2 怎么脱（占位符约定）

| 原值 | 文档（`.md`） | 代码 / 测试 |
|---|---|---|
| 手机号 | `<PHONE>` | `13800138000`；掩码样例统一 `138****8000` |
| 邮箱 / QQ | `<EMAIL>` / `<QQ>` | `user@example.com` / `100000000` |
| 本机登录名 | `<HOME>` | `C:\Users\<user>` |
| 仓库 / 工作区绝对路径 | `<WORKSPACE>` / `<REPO>` | **保留盘符形状**：`D:\workspace\…` |
| 密钥目录 | `<KEYS>` | `D:\keys` |
| 内网主机 | `<LAN_HOST>` | `<LAN_HOST>` |
| 凭证 | `<JWT>` / 从环境变量读 | 同左 |

两条踩过的坑：

1. **代码里别一律换成 `<WORKSPACE>`** —— 「路径必须是绝对路径、必须带盘符」这类断言会当场变红（`dsh-GOkifu-compact` 的 A7/A8 就是这么红的）。只换尾部，保留 `D:` 和分隔符。
2. **换假值后要同步改断言，且不同真号不能都换成同一个**：同一个文件里出现两个真号时，都变成 `13800138000` 会让两条掩码断言自相矛盾（`138****8000` ≠ `181****0632`）。

### 8.3 判据（能跑的命令）

```bash
node scripts/privacy-scan.mjs            # 扫已跟踪 + 未跟踪（不含 .gitignore）；0 = 干净
node scripts/privacy-scan.mjs --staged   # 提交前只扫暂存区
```

挂成 pre-commit（推荐，一行）：

```bash
printf '#!/bin/sh\nexec node scripts/privacy-scan.mjs --staged\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

### 8.3b 本地钩子：把 CI 的前置条件挪到推送之前

只挂脱敏还不够 —— CI 的五步（check / test / docs / privacy / pack）本地漏跑任何一步，推送后就是红一次、一封邮件、一轮返工。一条命令装两个钩子：

```bash
node scripts/install-hooks.mjs
```

| 钩子 | 什么时候跑 | 跑什么 | 实测 |
|---|---|---|---|
| `pre-commit` | 每次 `git commit` | `privacy-scan --staged`（只扫暂存） | 毫秒级 |
| `pre-push` 快档 | 每次 `git push` | `check` + `privacy-scan` | 0~1 秒 |
| `pre-push` 全档 | **合入点**：推 `main` / `git push -u` 首次推新分支 / `PLUGIN_FULL=1` | 快档 + `npm test` + `check-docs` + `pack --dry-run` | 约 3~5 秒 |

钩子模板在 `scripts/hooks/`（改模板后重跑 `install-hooks.mjs`，别手改 `.git/hooks/` 里的副本）。逃生门只跳过这一次：`PLUGIN_SKIP_HOOK=1 git push`。

**为什么分级**：分支是测试版通道，WIP 迭代会推很多次；把「只有合入点才等 3~5 秒」和「每次推送都等」分开，钩子才不会被绕过。派生项目长大后 `npm test` 会变慢，这条分级的价值才显出来。

**CI 的触发面**（`.github/workflows/ci.yml`）默认是 `push: branches: ["**"]` —— 模板自己要跑自测，所以对全部分支生效。派生仓库嫌分支推送太吵，可以把它收窄成 `[main]`：PR 仍然会跑 `rules`，只是不再为每次 WIP 推送消耗 runner 和通知。

### 8.4 已经 push 上去了怎么办

按这个顺序，别跳步：

1. **先轮换凭证**（token / 密码 / 会话）。重写历史不等于别人没抓过。
2. `git filter-repo --mailmap <map> --replace-text <rules>`
   —— `--mailmap` 顺手把作者邮箱换成 `…@users.noreply.github.com`；`--replace-text` 的规则是 `旧值==>新值`，正则写 `regex:…==>…`。
3. **对比 HEAD 的 tree 哈希**：改前改后 `git rev-parse HEAD^{tree}` 必须一致。一致才说明「用户装到的东西没变，只是 SHA 变了」；不一致就是误伤了当前版本，先回滚。
4. **force push 全部 refs + tags**。受保护分支要先临时关保护（`gh api -X DELETE repos/<o>/<r>/branches/<b>/protection`），推完按原样 `PUT` 回去 —— `enforce_admins` / `required_status_checks.contexts` 这些要逐个还原，别只把开关打开。
5. **归档仓库**推送会被拒（`remote: This repository was archived so it is read-only` → 403）：先 `PATCH {"archived":false}`，推完再 `true`。
6. **告知还在用的人重新 clone**：SHA 全变了，旧 clone 里的 commit 对不上，`git pull` 会打架。

### 8.5 为什么这条要进 AGENTS

因为它是**唯一一类「做得对不对，当时看不出来」的错**：代码能跑、测试能过、用户装得上，
只有等某天有人翻你的历史，才发现三个月前那次提交里有手机号和能用三天的 token。
判据只有一条 —— **提交前 `node scripts/privacy-scan.mjs` 退出 0**。
