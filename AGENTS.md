# AGENTS.md · B站推荐过滤扩展

Chrome MV3 扩展，过滤 B 站视频播放页右侧「接下来播放」推荐区，以及主站首页的推荐流。纯原生 JS，零依赖、零构建。

## 维护规则

改动前先读本文件。新增指标时**必须**同时改三处，否则规则编辑器里选不到：`src/lib/metrics.js` 的 METRICS 表、`src/lib/rules.js` 的 `numericValue`/`textValue` 取值分支、`tools/test-rules.mjs` 补一条测试。

任何改动都要跑通这三条命令，全绿才算完成：

```
npm test        # 规则引擎单测（149 项）
npm run e2e     # 真实 Chrome + 真实 B 站播放页端到端（35 项，需要联网）
npm run backup  # 导出/导入本地文件（17 项）
npm run quick   # 页面快捷按钮 + 设置页同步（10 项）
npm run popup   # popup 命中列表的标题链接（9 项）
npm run save    # 保存可靠性：点保存/切走/关浏览器重启（13 项）
npm run picker  # 标题拆字选词（23 项）
npm run fallback # 关键词首尾空格 + 元数据缺失兜底（8 项）
npm run home    # 主站首页：候选采集 / 标题兜底 / 类别开关 / 视口懒取（18 项，需要联网）
```

`npm run verify` 是 WBI 签名与接口连通性的专项检查，改了 wbi.js 或 sw.js 的请求层时跑。`npm run pack` 打发布 zip（见下方「发版」）。

仓库是公开的（MIT），提交前自己过一遍：不能有密钥 / cookie / token，不能有个人 mid 或真实姓名的测试配置，不能有本机绝对路径（`D:/Projects/...`、`C:/Users/你的名字/...`）。脚本里要找浏览器可执行文件一律用 `tools/chrome.mjs` 的 `chromeExecutable()`，不要在 spawn 里写死路径——那样只有你这台机器能跑。截图改了要同步 `docs/screenshots/`，那是 README 直接引用的副本。

不要引入 npm 依赖、不要引入构建步骤、不要用 TypeScript。这台机器装包有风险，且扩展要能 load unpacked 直接跑。

不要删除任何文件。不要提交密钥。

## 目录结构

```
manifest.json              MV3 清单。content script 有两个：inject.js（world: MAIN）和 content.js
src/lib/                   纯逻辑，无 DOM、无 chrome API 依赖（defaults.js 是唯一例外，它包了 storage）
  metrics.js               指标定义表（label/单位/类型/是否需要远程请求）
  rules.js                 规则引擎：evaluate() / ruleMatches() / 白名单 / 黑名单 / 展示值解析
  presets.js               预设规则包
  defaults.js              设置结构、归一化、chrome.storage 读写封装
  wbi.js                   WBI 签名 + 自实现 md5（service worker 里没有 md5）
src/content/
  inject.js                MAIN world。读 window.__INITIAL_STATE__.related（主）+ hook fetch/XHR（备）
  content.js               扫 DOM、按 bvid 关联、判定、摘卡片、悬浮快捷按钮
  content.css              快捷按钮与占位样式
src/background/sw.js       消息路由、远程抓取（标签/UP频率）、限速队列、缓存、风控退避
src/options/               规则编辑器（规则/批量关键词/名单/预设/高级/日志）
src/popup/                 当前页统计、总开关、本页命中记录
tools/
  test-rules.mjs           规则引擎单测（149 项），用 fixtures 里的真实接口数据
  e2e.mjs                  真实 Chrome + 真实播放页的端到端验证（35 项）
  test-backup.mjs          导出/导入本地文件的端到端验证（17 项）
  test-quick.mjs           真实鼠标悬浮 → 快捷按钮 → 设置页同步的验证（10 项）
  test-popup-links.mjs     popup 命中列表的标题链接（9 项）
  test-save.mjs            保存可靠性：点保存/切走/重启（13 项）
  test-titlepicker.mjs     标题拆字选词 → 逗号切分 → 提交（23 项）
  test-fallback.mjs        关键词首尾空格 + 无元数据卡片走 DOM 兜底（8 项）
  test-home.mjs            主站首页端到端：候选采集 / 标题兜底 / 类别开关 / 视口懒取（18 项）
  chrome.mjs               解析本机 Chrome/Edge/Chromium 路径（BRF_CHROME 环境变量优先，三平台探测）
  pack.mjs                 打发布 zip（out/bili-recommend-filter-<版本>.zip），自实现 ZIP 写入，零依赖
  cdp.mjs                  极简 CDP 客户端（无依赖）
  verify-wbi.mjs           md5 + 签名 + 接口真实连通性
  shot.mjs / shot-toolbar.mjs  设置页与快捷按钮的截图脚本（输出到 out/）
  diagnostics/             一次性诊断脚本，不参与 npm scripts，也不进 CI
    probe-keyword.mjs        诊断「某些关键词不过滤」：逐字比对、码点、规则状态
    probe-scroll.mjs         诊断滚动加载后的卡片是否还在元数据集合里
    probe-352.mjs            -352 风控排查（记录 dm_img_* 解法）
    probe-dom.mjs            过滤效果采样诊断（看是收敛还是反复回流）
    probe-header.mjs         检查过滤时是否误摘了大容器（导航栏/播放器）
    probe-ancestors.mjs      打印每个 anchor 的祖先链，定位卡片容器为什么算错
    probe-hydration.mjs      对比 remove / hide 是否引发页面脚本错误
    probe-playback.mjs       过滤是否导致播放器重建
    probe-visual.mjs         截图对比：列表是否真的上移
    probe-viewzero.mjs       诊断「播放量被判成 0」这类数据源问题
    probe-carddom.mjs        打印卡片内部 DOM 结构，定位播放量在哪
    probe-parse.mjs          用真实卡片文本验证播放量解析函数
    probe-download.mjs       下载行为诊断（headless 下会被取消）
    probe-net.mjs            抓页面实际请求，确认数据来源
    probe-state.mjs          定位 SSR 状态对象结构
  cookie-jar.mjs           验证脚本用的最小 cookie jar
  fixtures/                真实接口返回快照
docs/screenshots/          README 用的截图（对应 out/ 里的原始文件）
LICENSE                   MIT
```

## 关键设计（改代码前必读）

**推荐数据是 SSR 直出的，不是接口。** 这是最反直觉、也最容易踩的一点：B 站播放页右侧「接下来播放」的 40 条数据直接内联在初始 HTML 里，挂在 `window.__INITIAL_STATE__.related` 上，页面**根本不会去请求** `/x/web-interface/archive/related`。所以 `inject.js` 的主路径是轮询读这个全局对象（MAIN world 才能读到页面全局），fetch/XHR hook 只作备用，防止将来改回接口形式。`content.js` 还会向 SW 要一次 related 接口数据作为补充集，两个集合取并集能提高覆盖率（实测并集 58 条，SSR 40 条 + 接口 40 条有重叠）。

**bvid 是唯一稳定锚点。** `relatedSet` 里的 bvid 集合 ≈ 右侧推荐区渲染的卡片集合，用它反查 anchor 就能精确圈定推荐卡片，不需要任何 B 站 class 名。卡片容器的定位用 `findCardRoot()`：从 anchor 往上爬，直到父节点包含其他 bvid 为止——这个算法与 class 名无关，B 站改版也不会坏。实测卡片结构是 `<div class="video-page-card-small">`，每张卡有两个同 bvid 的 anchor（封面 + 标题），靠 `dedupeByCard()` 合并。

**广告卡片不过滤。** 右侧会混入 `ad-report-inner` 的广告卡，它的 bvid 不在 `related` 里，没有元数据，因此不会被当成候选。这是有意为之。

**wbi 接口有风控。** `/x/space/wbi/arc/search` 必须同时满足：wbi 签名（w_rid + wts）+ `dm_img_*` 四个设备指纹参数。缺任何一个都是 `-352 风控校验失败`，只签名不够。dm_img 参数由 content.js 用真实 WebGL 信息生成后传给 SW（真实值比伪造值安全）；被风控时 SW 会换回已验证的静态值重试一次，仍失败则进入指数退避。

**拿不到的数据一律是 null，绝不能用 0 兜底。** 这条踩过一次真实的坑：`itemFromRelated` 里写 `Number(stat.view) || 0`，在 `availableVideoList` 这种没有 `stat` 字段的数据源上，整个右侧推荐的播放量全变成 0，于是「播放量 <1000」规则把一页推荐全部误杀。现在所有数值字段缺失都是 `null`，`numericValue()` 返回 `null` 时 `ruleMatches()` 返回 `null`（无法判定）→ 跳过该规则。`computeRates()` 同理：`like` 缺失时点赞率是 `null` 而不是 0。单测第 11、12 节专门守这个。

**不同页面形态的数据源不一样，必须通用采集。** `/video/BVxxx` 的推荐在 `__INITIAL_STATE__.related`；`/list/watchlater`（稍后再看）、`/list/xxx?type=series`（合集）在 `playlist` / `resourceList` 里；`availableVideoList`（分P列表）字段残缺。所以 `inject.js` 的 `harvest()` 递归扫整个 `__INITIAL_STATE__`，把所有「含 bvid 的对象数组」都交给 content.js，由 `ingestRelated()` 按 bvid **合并**（空字段不覆盖已有值）。只读 `related` 会在 `/list/*` 页面上拿到空数据。

**远程指标拿不到就不参与判定。** 这是硬约束：标签接口或 UP 频率接口失败、被风控、被限速时，规则状态是 `fail`，`evaluate()` 直接跳过该规则（不是当作命中）。宁可漏杀，不可误杀。状态为 `pending` 时卡片先 `visibility:hidden` 占位，结果回来再决定摘掉还是恢复；`ask()` 有 8 秒硬超时，防止永远卡住。

**规则是 OR 语义。** 任一规则命中即过滤。白名单（UP mid / UP 名 / 标题词 / 标签词）优先级最高，其次是黑名单 UP，最后才是规则表。

**命中后的处理默认是 CSS 隐藏，不是删节点。** 这一条是踩坑换来的：`card.remove()` 会让 B 站框架在下次 patch 时找不到节点，抛 `Script error`，表现为页面重新渲染、播放中断。实测证据在 `tools/diagnostics/probe-hydration.mjs`：remove 模式有 `err@2xxx:Script error.`，hide 模式没有。`display:none` 在视觉上和删除完全等价（列表照样上移、不留空隙），但不改 DOM 结构，框架不会错乱。`action: "remove"` 保留给用户手动选，但默认值是 `hide`，不要改回去。

被隐藏的节点和它的父节点/位置记在 `state.removed` 里，设置变更时能复原重判——这是「调规则不用刷新页面」的基础。注意 `restoreAll()` 里要先判 `isConnected`，hide 模式下节点本来就在 DOM 里，不能乱挪位置。

**卡片定位不能只靠结构判据。** B 站把右侧列表的**第一张卡片**单独包在 `.next-play` 里（和「接下来播放」标题、分割线同级），其余卡片才是列表容器的直接子元素。所以「父节点里出现第二个 bvid 就停」这个纯结构算法在第一张卡片上会失效：`.next-play` 里只有一个 bvid，算法继续往上爬，最后把 `.next-play` 甚至更大的容器当卡片摘掉，表现就是右侧推荐区整块消失、顶部导航栏消失。

现在 `findCardRoot()` 的顺序是：已知 `listRoot` 直接定位 → `deepestCardish()` 用 class 线索下钻到真正的卡片层 → 结构算法兜底 → `plausibleCard()` 最后把关（高度 ≤420px、宽度 ≤视口 62%、不含 header/nav/播放器）。`listRoot` 由 `learnListRoot()` 从一批候选卡片的共同父节点学出来并缓存，这样即使卡片被逐个隐藏、父节点里只剩一个 bvid，也不会爬过头。

**关键词的切分规则是用户明确定下的，别自作聪明改。** 只有中英文逗号「，」「,」是分隔符，连续逗号产生的空片段丢弃，**绝不 trim**（空格本身可以是过滤词），完全等于提示文案 `(这有一个空格)` 的片段丢弃。切分逻辑在 `rules.js` 的 `splitKeywordInput()`，单测第 13 节有 22 项覆盖。

**`displayKeyword()` 只能用于展示，绝不能把它的返回值存进配置。** 它会把空格换成 `␣` 并追加 `(这有一个空格)`，一旦回灌进输入框或 storage，就会存进一个带提示文案的假关键词。所以设置页的 textarea / input 的 `value` 永远是原始关键词，提示只出现在旁边的 chip 预览里（`renderKeywordHints()`、规则表的 `cellHint`、`describeRule()`）。

**popup 的测试要 mock `chrome.tabs`。** popup 靠 `chrome.tabs.query({active:true, currentWindow:true})` 拿当前标签页，在测试环境里 popup 自己就是 active tab，拿不到 B 站页。所以 `test-popup-links.mjs` 用 `Page.addScriptToEvaluateOnNewDocument` 在 popup 加载**之前**注入 mock（注意必须先开 about:blank、注入、再导航，顺序反了脚本赶不上第一次加载），用 `Object.defineProperty` 覆盖 `chrome.tabs.query` / `chrome.tabs.sendMessage`。

**`writeSettings()` 的返回值绝对不能赋回 `settings`。** 这是最阴的一个 bug：`writeSettings` 内部走 `normalizeSettings`，会返回一个全新对象（连 `settings.rules` 里每条规则都是重新创建的）。一旦 `settings = await writeSettings(settings)`，规则表格里每个输入框的事件监听器闭包捕获的 `rule` 就和 `settings.rules` 脱钩了——之后的编辑全部改在孤儿对象上。表现是「改完不生效 / 刷新变回原值 / 重启变回原值」，而且只在**第一次保存之后**才出现，非常难查。现在 `flushSave()` 里是 `await writeSettings(settings);`，不接收返回值。

**保存必须是「dirty 标记 + 显式按钮 + 切走前 flush」三件套。** 早期只有 400ms 防抖，用户改完切到 B 站（后台标签页定时器被 Chrome 节流到 ≥1s），切回来时 `visibilitychange` 触发 `refreshFromStorage()` 读到 storage 里的旧值，把内存覆盖掉，随后定时器写入的也是旧值。现在：`dirty` 为 true 时 `refreshFromStorage()` 直接 return（本地未保存的修改优先）；`visibilitychange → hidden` 时 `flushSave()`；`pagehide`/`beforeunload` 再兜一次；右上角常显「已保存 / 有未保存的修改」，保存按钮在 dirty 时脉动，支持 Ctrl+S。

**设置页必须监听 storage 变化。** 页面上的「屏蔽此UP」「标题词+」、popup 的总开关都是直接写 `chrome.storage`，不经过设置页。如果设置页只在打开时读一次，用户操作完回到设置页会看到打开时的快照，以为没生效——这个坑真实发生过。现在 `options.js` 的 `initExternalSync()` 监听 `chrome.storage.onChanged` 并重新渲染，用 `selfWriteUntil`（自己保存后 1.5 秒内跳过）避免把自己刚填的内容重置掉，用 `isEditingInPage()` + `pendingRefresh` 避免打断正在输入的框。

**快捷工具栏是两态：收起 = 卡片右下角两个小图标，展开 = 完整面板。** 收起态贴在卡片 `getBoundingClientRect()` 的右下角，目的是不挡封面和标题（用户要先预览、或悬停看全名）。展开态从卡片左上角铺开，此时遮挡无所谓。状态由 `.brf-toolbar--open` 控制，`positionToolbar()` 只读这个类决定贴哪儿，所以开关面板后必须再调一次它。`closeEditor()` 有幂等保护（没展开就直接 return），避免重复调用时多算一次布局。

**快捷按钮的提示不能被立刻藏掉。** `hideToolbar()` 会连提示一起隐藏，所以点击后是「先 flash 再延迟 1.6 秒隐藏」，不是立刻隐藏。另外 `hideToolbar()` 默认不会在输入框有焦点时执行（滚动页面会触发它，会把用户刚打的字弄丢）。

**设置代际（state.gen）不能删。** 判定是异步的（要 await 动态 import 和远程请求）。如果设置在中途变了，正在跑的判定必须作废（`if (gen !== state.gen) return;`），否则会出现「旧设置算到一半 → 新设置到达 → 卡片被标记已完成 → 永不重判」的 bug。这个 bug 曾经让 20 条里只过滤掉 13 条。

## 主站首页（第二个页面形态）

除播放页外，`https://www.bilibili.com/` 首页也支持过滤（v0.2.0 起）。以下是踩过的坑，改这块之前必读。

**首页地址会被改写成 `/index.html`。** 实测：打开 `https://www.bilibili.com/`，页面客户端路由会把它改成 `https://www.bilibili.com/index.html` 并做一次导航。所以 manifest 里三个 pattern 都得有：`https://www.bilibili.com/`、`https://www.bilibili.com/?*`（带 query 的首页）、`https://www.bilibili.com/index.html`；`isHomePage()` 也把这三个形态都算首页。少写一个的表现是「首屏能过滤，滚一下就全部失效、消息发不进去」（Receiving end does not exist）。

**首页没有 `__INITIAL_STATE__`。** 抓整页 HTML 实测：`__INITIAL_STATE__` 出现 0 次，`"bvid"` 出现 0 次，服务端只预渲染了 10 张卡片（`bili-video-card is-rcmd`），其余全靠接口。但 feed 接口 `/x/web-interface/wbi/index/top/feed/rcmd` 返回的 `data.item[]` 与播放页 related **字段同构**（`bvid` / `duration` / `pubdate` / `owner{mid,name}` / `stat{view,like,danmaku}`），而 `inject.js` 的 `WATCHED` 早就写了这个 endpoint、`extractItems` 也会读 `data.item`。所以元数据链路不需要为首页写任何新代码。

**列表容器不能靠 class 名。** `RECO_ROOTS` 在首页一个都不匹配。现行做法在 `learnHomeRoot()`：按「祖先链签名」（每层标签名 + 首个 class）给 anchor 分组，取最大的一组求最深公共祖先。每个 anchor 只读 6 层属性，不做子树遍历——这是为了守住性能红线，全页 `querySelectorAll` 在首页上会直接把主线程卡死。

**整行被过滤时必须连外层 wrapper 一起藏。** 实测数据（1600×1100 视口，五列网格，x = 140/400/660/919/1179）：只藏 `.bili-video-card`，那一行视觉上消失但**下面所有行原地不动**，留下 210px 空洞；藏掉它的外层 wrapper，下一行立刻上移 270px 补位；只藏行中间一张时，同行剩下的卡片正常左移。逻辑在 `collapseTarget()`：向上找「高度与卡片几乎一致、只含这一个 bvid、子元素不多」的祖先，最多爬两层。播放页卡片直接挂在列表容器下，循环第一次就退出。

**标题兜底在首页会抓错元素。** `readCardFallback()` 里用 `querySelector('[class*="title"]')` 在首页命中的第一个元素是 `span.no-interest-title`，内容就是「不感兴趣」——标题关键词规则全部失效。现在按可靠度排序：`h3[class*="tit"]` → `[class*="info--tit"]` → `h3` → `a[href*="/video/BV"][title]` → `[class*="title"]`，并排掉 `no-interest / mask / tooltip / hover / skeleton / placeholder` 这些装饰元素。

**骨架卡不能打 done 标记。** 首页卡片先占位再填内容，骨架阶段没有标题和时长。如果把它当候选判成「通过」并写上 `data-brf-done="1"`，真实数据到了也不会重判。现在 `dedupeByCard()` 会跳过「没有元数据且 innerText 少于 2 个字符」的卡片，等它渲染出来再纳入候选。

**番剧/影视/漫画/课程/直播/赛事/广告卡没有 bvid 或元数据不全**，走不了规则引擎，所以只能按类别整类隐藏（`applyCategoryToggles()`）。两个信号：

一是**卡面角标**（`badgeKind()`）。这是漫画和赛事唯一的可靠信号：实测漫画卡指向 `manga.bilibili.com/detail/mc…`，而**赛事卡指向的是普通视频页**（`https://www.bilibili.com/video/BV1T8xm6EEqi/`），链接上完全看不出是赛事。首页 bundle 里这类卡的结构是 `.badge > .floor-title`（文字来自数据），但不依赖 class 名，改成「在卡片内找前 40 个叶子节点、文本恰等于固定词表里的词」，数字（播放量、时长）不会误中。

二是**链接指向**：`manga.bilibili.com` → 漫画、`live.bilibili.com` → 直播、`/cheese/play/` → 课程、`/v/game/match` 或 `/v/esports` → 赛事、`/bangumi/play/` → 番剧或影视（链接形状一样，靠卡面文案区分，所以 movie 必须排在 bangumi 前面）。

三是**商业推广打点域**：推广卡（卡面标「推广 / 赞助」）不一定带 `ad-report` 这类 class，也不一定有角标文本，但卡片里的链接或 `data-*` 属性会指向 `https://cm.bilibili.com/cm/api/fees/pc/sync…`——这是用户实测给的判据，比 class 名稳。所以 `promo` 类别先扫 `[href*="cm.bilibili.com"], [data-href*="cm.bilibili.com"], [data-url*="cm.bilibili.com"], [data-click-url*="cm.bilibili.com"], img[alt*="推广"], [title*="推广"]`，再把角标词表里的「推广 / 赞助」也归到 `promo`。【注：开发时手上只有未登录 profile，推荐流里一条推广卡都没出现（全页只有一处 `//cm.bilibili.com` 链接），所以这条主要靠用户提供的域名证据，用注入的假卡片做确定性测试。日后如果在真页面上发现它还有别的打点域，补进那个选择器即可。】

元数据里的类别（`goto`）不可靠：`ingestRelated` 只收 bvid 条目，番剧/直播/漫画本来就进不来。开关语义是「勾上 = 不显示」，默认全关。

**主站的额外请求默认关。** `settings.home.remote` 默认为 `false`，与播放页的 `remoteEnabled`（默认 true）分开：首页会无限滚动、卡片没有上限，开一次就可能把单页预算吃光。开启后也只给视口上下 300px 内的卡片发请求（`nearViewport()`），不在范围内的卡片**不标记完成**，滚回来时 `scroll` 监听会再扫一次。

**测试是独立的。** `npm run home`（24 项）真实打开首页，守的是这六条：首屏不等接口就有候选、标题不是「不感兴趣」、规则能过滤、被藏的是外层 wrapper、类别开关能开能关（含注入的漫画/赛事/推广假卡片）、`home.remote=false` 时零额外请求。播放页那套 `npm run e2e` 断言（右侧列表、related 元数据）在首页完全不适用，不要强行复用。

## 关键词为什么「加了却不过滤」

两类原因，都已经修了，别再退回去：

**一类是看不见的空白。** 关键词很容易带上首尾空格（手打、粘贴、从拆字面板点进空格都行）。`"女".includes` 和 `"女 ".includes` 是两个词，后者永远匹配不到标题。实测 `海 `（码点 `6d77,20`）在 7 张含「海」的卡片里只拦到 1 张——就是那张标题里真有「海␣」的。现在 `normalizeKeyword()` 在**匹配时**（`asKeywordList`）和**入口处**（options 切分 / picker 提交 / SW 写入）都做归一：纯空白词原样保留（用户确实想过滤空格），有可见字符就去首尾空白，中间空格不动。匹配时也归一这一点很重要——已经存进 storage 的脏数据不用迁移就能生效。

**一类是元数据没覆盖到。** 早期 `collectCandidates()` 是「bvid 不在 `state.related` 里就跳过」，于是元数据没覆盖的卡片永远不会被判定。现在改成以 DOM 为准：已知 `listRoot` → `RECO_ROOTS` → 全页兜底，元数据只负责补字段；匹配不上元数据的走 `readCardFallback()` 从 DOM 抠标题。拿不到的字段是 `null`，会安全跳过对应规则。广告位（`ad-report` / `ad-floor` / `advert`）直接排除。

自检手段：`BRF_EXPLAIN` 消息会返回每张候选卡的 `title / source / decision / 未命中的词及其码点`，`npm run fallback` 跑这个链路。

## 性能红线（踩过坑）

`findCardRoot()` 里**绝对不能**用 `querySelectorAll("*")` 这类全子树遍历。B 站播放页元素上万，每次扫描要给 40 个 anchor × 10 层祖先各算一次，叠加 MutationObserver 的高频触发，会把页面主线程彻底卡死（实测连 CDP 的 `Runtime.evaluate` 都超时）。现在用 `parent.children.length > 40` 做便宜的体量防御，并用 `cardCache`（WeakMap）缓存 anchor → 卡片，重复扫描几乎零成本。

扫描节奏：MutationObserver 防抖 350ms，保底轮询 2500ms，`document.hidden` 时直接跳过。`state.lastScanCost` 会记录单次扫描耗时，超过 60ms 会在控制台告警——修改扫描逻辑后看一眼这个值。

## 已知脆弱点

卡片文本的播放量解析在 `rules.js` 的 `extractViewFromText()`，按可靠度分四级：带「播放」字样 → 裸数字带万/亿 → 卡片末尾「播放量 弹幕数」两个数字取倒数第二个 → 都失败返回 null。小于一万的播放量在 DOM 里是纯数字（「606」「4368」），不带「万」也不带「播放」，只能靠位置认，所以第三条要求文本里必须有时长串（确认是视频卡片）。这套逻辑有 22 项单测。

DOM 适配集中在 `content.js` 的 `findCardRoot()` / `plausibleCard()` / `readCardFallback()`（两个页面共用）；首页额外靠 `learnHomeRoot()` / `collapseTarget()` / `classifyCard()`；数据来源集中在 `inject.js` 的 `readInitialState()`（SSR 路径）和 `WATCHED` 正则（接口路径，已覆盖首页 feed）；接口集中在 `sw.js` 的 `ENDPOINTS`。B 站改版时按这个顺序查。

首页的三个具体脆弱点：地址可能再变（已经踩过一次 `/` → `/index.html`）、卡面类别标记文案可能变（`classifyCard()` 靠「电影/影视/纪录片/片单」区分影视与番剧）、网格层级可能变（`collapseTarget()` 依赖「卡片外层有一层等高 wrapper」这个结构事实）。

B 站若改成虚拟列表（复用 DOM 节点），需要给卡片加 bvid 标记避免重复处理。

## 工作步骤

改完代码 → `npm test`（规则引擎）→ `npm run e2e`（真实浏览器端到端）→ `npm run backup`（导出/导入）→ `chrome://extensions` 点刷新 → 打开任意播放页 → 看 popup 里的命中日志。

E2E 脚本有三个坑已经踩过，不要退回旧写法：headless 下 `--load-extension` 在 Chrome 137+ 已失效，必须 `--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked`；`chrome.storage` 只在扩展页面里存在，读写设置要走一个常驻的 options 页目标；`chrome.tabs.sendMessage` 只能在扩展上下文里调用。

连续跑 E2E 会把本机 IP 打进 B 站 `-412` 风控冷却（每个页面最多几十个请求）。所以 E2E 里远程规则的断言是自适应的：接口可用就验证「能过滤」，不可用就验证「不误杀」。两件事都得是绿的。

## 发版

顺序不能乱，前一步不绿就不要往下走：

1. 改 `manifest.json` 和 `package.json` 的 `version`，两处必须一致（`npm run pack` 会检查，不一致直接退出码 2）
2. `npm test`、`npm run check` 全绿；有条件再跑一次 `npm run e2e`
3. `npm run pack` → 产出 `out/bili-recommend-filter-<版本>.zip`，24 个文件、manifest 在 zip 根目录
4. 用 zip 里的内容实际载入一次：解压 → `chrome://extensions` → 「加载已解压的扩展程序」→ 打开任意播放页看过滤是否正常
5. 提交并推送：`git add -A && git commit && git push`
6. 建 Release 并附上 zip：`gh release create v<版本> out/bili-recommend-filter-<版本>.zip --title "..." --notes-file <文件>`

**第 6 步是发版流程的固定环节，不用再问用户要不要发（2026-11-04 已明确授权）。** `gh release create` 会自动在默认分支 HEAD 上建 tag，所以不必单独 `git tag`；但如果手动打了 tag，要确保它指向刚推上去的那个 commit。

发完核对三件事：`gh release view v<版本> --json tagName,isDraft,assets` 看 tag 是不是 HEAD、附件大小与本地产出的 zip 一致、`isDraft` 为 false。Release 说明写清「新增了什么 / 修了什么 / 已知限制 / 安装步骤」，别只丢个包。

版本号同时也是 Chrome 认的那个版本（`chrome://extensions` 卡片上显示的就是它），所以只改了边角代码但功能无变化时，不必强行发版。

打包脚本自己写 ZIP 字节而不调用 `zip` / `Compress-Archive`：前者不一定装，后者只有 Windows 有。改它的时候用 `unzip -l` 或 .NET 的 `ZipFile.OpenRead` 验一遍能读、能解压、`manifest.json` 在根目录。
