# Node.js detail API 抖音链接检测

本目录是抖音链接有效性检测的新方案，路径为 `methods/node_detail_api`。工具从 Excel 读取抖音链接，使用 Playwright 启动系统 Chrome/Edge 打开页面，优先捕获 detail API 的 JSON 响应，再输出带中文结果列的 Excel。

## 安装依赖

PowerShell 直接执行 `npm` 可能受执行策略影响，建议统一使用：

```bash
cmd /c npm install
cmd /c npm run check
cmd /c npm test
```

依赖包括 `playwright`、`exceljs`、`p-limit`。本方案优先使用系统 Chrome/Edge，不强制安装 Playwright 自带浏览器。

## 本地 Web UI 服务

```bash
cmd /c npm install
cmd /c npm start
```

启动后访问 `http://localhost:3000`。双击 `run.bat` 也会启动同一个本地 Web UI 工作台，并在控制台提示访问地址。

Web UI 默认使用两阶段检测：第一阶段 HTTP detail API 快筛默认并发 `5`；第二阶段 Playwright 兜底默认并发 `2`，如果遇到风控、浏览器资源紧张或结果不稳定，应降为 `1`。

默认开发、测试和验收不运行真实抖音网络检测；真实检测必须由用户明确要求。全流程仍然不使用 `networkidle`。

## 无登录游客 Cookie 刷新

本方案不实现扫码登录、账号登录，也不读取用户 Chrome/Edge 的登录态。Cookie 只来自无登录游客上下文：服务端通过 Playwright 新建干净浏览器上下文，访问 `https://www.douyin.com/` 或公开作品链接，让站点自然下发游客 Cookie，然后读取抖音域 Cookie，归一化后保存到 `.local/cookies.json`。

Web UI 顶部提供“刷新 Cookie”按钮，对应接口为：

```bash
POST /api/cookie/refresh
```

刷新接口只返回 `exists`、`summary`、`refreshedAt` 等脱敏状态，不返回 Cookie 明文。状态栏会显示 Cookie 摘要和最近刷新时间。

API 快筛阶段会自动处理 Cookie：

- 如果本地 Cookie 缺失，会先尝试刷新一次无登录游客 Cookie，再请求 detail API。
- 如果 detail API 返回疑似 Cookie 失效、鉴权、验证码、访问频繁或风控提示，会刷新一次 Cookie 并重试一次。
- 自动刷新有并发保护：多个链接同时触发刷新时，只会实际运行一个浏览器刷新流程，其他请求等待同一个结果。
- 刷新失败不会中断整批任务，会记录脱敏错误并转入 Playwright 兜底检测。

## 最简单 API 方法

Web UI 提供“参数种子链接”输入框，默认值为 `https://www.douyin.com/video/7607987902190013723`。任务启动时只会使用这个种子链接进行一次干净浏览器上下文预热，捕获真实 detail API JSON 请求 URL、对应请求 headers，以及同一浏览器上下文里的抖音域 Cookie，并生成短期参数画像；不会按 Excel 前 3-5 条自动尝试，也不会默认使用 Excel 第一条 URL 预热。种子链接为空或不是 `/video/`、`/note/`、`/share/video/` 抖音作品链接时，会跳过预热并直接使用旧 HTTP 候选和 Playwright 兜底。

当前最简单 API 方法是：只用一次 seed 浏览器预热拿到真实 detail API 画像，后续批量阶段不再大批量打开浏览器，而是由 Node HTTP/fetch 复发 profile candidate。profile candidate 完整保留种子 URL 的查询参数，包括 `msToken`、`a_bogus`、`timestamp`、`x-secsdk-web-signature` 等签名或动态参数；生成待检测候选时只替换作品 ID 参数，例如 `aweme_id`、`item_id`、`aweme_ids`。请求 headers 只复用安全 allowlist：`user-agent`、`accept`、`accept-language`、`referer`、`sec-ch-ua`、`sec-ch-ua-mobile`、`sec-ch-ua-platform`、`uifid`，Cookie 使用 seed 浏览器上下文捕获到的抖音域 Cookie 单独设置。

有效参数种子链接会在任务开始检测前阻塞式预热：系统会先等待种子画像 ready，或等待预热失败并记录降级日志，然后再启动检测队列。检测时优先请求 profile candidate；如果 profile 请求失败、返回风控或无法确认，再回退旧 HTTP 候选和 Playwright 兜底。签名参数仍会标记为 volatile，日志、状态和错误中只展示参数名、header 名称和 Cookie 数量，不展示 Cookie、`a_bogus`、`x-secsdk-web-signature`、`msToken` 等明文值。

多个检测同时触发预热时只会实际运行一个 Playwright 预热流程。预热失败不会阻塞任务，结果仍会走旧 HTTP 候选和 Playwright 兜底；任务结果 JSON 中会包含 `apiCacheUsed`、`apiProfileStatus`、`apiCandidateSource`、`apiCandidateSources` 等观测字段，便于判断为什么进入兜底。

## CLI 保留入口

```bash
node src/main.js
cmd /c npm run start:cli
node src/main.js input/测试.xlsx output/检测结果.xlsx
# 仅测试验证用：只检测前 3 条非空链接，正式检测不要带 --limit
node src/main.js ..\python_playwright_dom_text\test.xlsx output\检测结果.xlsx --limit 3 --concurrency 1 --delay 1000
node src/main.js --help
```

CLI 正式检测不要带 `--limit`，会全量检测默认输入文件中的非空链接。`--limit` 只用于小批量验证，不代表正式结果。

默认输入查找顺序：

1. `input/测试.xlsx`
2. `input/test.xlsx`
3. `../python_playwright_dom_text/test.xlsx`

默认输出路径：`output/检测结果.xlsx`。

## 参数

| 参数 | 说明 |
|------|------|
| `--limit <数量>` | 只检测前 N 条非空链接，适合真实小批量验证 |
| `--concurrency <数量>` | 并发数，默认 `1`，建议保持保守 |
| `--delay <毫秒>` | 每条链接启动检测前的间隔，默认 `1000` |
| `--timeout <毫秒>` | 页面打开超时，默认 `15000` |
| `--help` | 显示中文帮助 |

正式检测不要使用 `--limit`。如果输出中出现备注 `超过 --limit 限制未检测`，说明当前命令主动限制了检测数量，不是系统漏检。

## Excel 输入输出

输入默认读取第一个工作表。链接列自动识别规则：

- 优先匹配表头完全等于 `链接`。
- 其次匹配表头包含 `链接`、`URL`、`url`、`地址`。
- 如果表头无法识别，会扫描前若干行中包含 `douyin.com`、`/video/`、`/note/`、`/share/video/` 的单元格。

输出保留原始列，并追加中文列：

- `状态`
- `最终链接`
- `备注`
- `检测时间`
- `检测依据`

空链接行输出为 `跳过`，备注为 `链接为空`。使用 `--limit` 时，超出限制的非空链接输出为 `跳过`，备注为 `超过 --limit 限制未检测`。

## 判定逻辑

- detail API 优先：捕获 JSON 响应后，根据 `aweme_detail`、`aweme_id`、`desc`、`statistics`、`video`、`images`、`image_post_info` 等结构化字段判断存活和内容类型。
- DOM 兜底：未捕获有效 JSON 时，读取 `document.body.innerText`，根据 `你要观看的视频不存在`、`你要观看的图文不存在`、`抱歉，作品不见了` 判断失效，根据 `点赞`、`评论`、`发布时间`、`关注` 判断存活。
- 风控待确认：出现登录、验证码、安全验证、访问频繁等文案时输出 `待确认`。
- `/video/` 跳转 `/note/` 且有存活证据时，输出 `存活` + `图文`，检测依据为 `url_redirect`。
- 检测器不使用 `networkidle`，只使用 `domcontentloaded` 加固定等待，避免等待时序导致误判。

## 一键启动

双击 `run.bat` 可启动本地 Web UI 服务，等价于在当前目录执行 `cmd /c npm start`。启动后访问 `http://localhost:3000`。脚本会检查 Node 和 `node_modules`，依赖缺失时提示执行：

```bash
cmd /c npm install
```

服务运行期间窗口会保持打开；关闭窗口或按下中断键会停止本地服务。CLI 检测仍可通过 `node src/main.js` 或 `cmd /c npm run start:cli` 单独使用。

## 已验证命令

```bash
cmd /c npm run check
cmd /c npm test
node src/main.js --help
node src/main.js
# 仅测试验证用：该命令会因为 --limit 3 跳过第 4 条非空链接
node src/main.js ..\python_playwright_dom_text\test.xlsx output\检测结果.xlsx --limit 3 --concurrency 1 --delay 1000
```

历史 CLI 阶段验证记录：执行 `node src/main.js` 不带 `--limit`，全量检测 4 条，汇总为存活 2、失效 2、待确认 0、跳过 0、失败 0。输出文件为 `methods/node_detail_api/output/检测结果.xlsx`。

历史 CLI 阶段验证记录：真实小批量验证结果来自 `--limit 3` 命令，仅用于测试验证；3 条实际检测中，1 条存活并从 `/share/video/` 跳转到 `/note/`，2 条通过 DOM 失效文案判定失效；第 4 条因 `--limit 3` 被人为限制而跳过。正式运行去掉 `--limit`。

本轮 Web UI 文档阶段说明：Task 9 只更新文档，未启动 Web UI 服务，未执行真实抖音网络检测；Task 10 尚未完成。以上历史 CLI 阶段验证记录不代表本轮 Web UI 最终验收。

## 限制

- 抖音接口路径、字段和页面文案可能变化，`classifier.js` 中的规则需要持续用真实样例验证。
- 真实页面可能触发登录、验证码、地区限制或风控；这类情况不能当作失效，应记录为 `待确认`。
- Web UI 第一阶段 API 快筛默认并发 `5`，第二阶段 Playwright 兜底默认并发 `2`，不稳定时降为 `1`；CLI 默认并发保持 `1`。
- 旧 Python DOM 文本方案仍保留在 `methods/python_playwright_dom_text`，本方案不修改旧方案。

## 代码审查修复说明（2026-06-23）

- Excel 输出采用“读取原 workbook 后在原工作表追加结果列并另存”的方式，不再新建空 workbook 复制 value；ExcelJS 能保留的多工作表、列宽、样式、公式、超链接、合并单元格会随原 workbook 保留。
- detail API 捕获只接受明确 detail/post 接口路径，或 JSON 本身具备作品详情字段组合；普通 JSON 不会阻止后续响应继续捕获。
- 结构化存活判断不再接受通用 `id` 或单个 `desc` 字段，需具备 `aweme_id`、`statistics + video/images`、`video/images + desc/title/aweme_id` 等组合证据。
