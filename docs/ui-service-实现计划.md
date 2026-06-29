# UI 服务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `methods/node_detail_api` 中实现本地 Web UI 服务，双击 `run.bat` 启动 `http://localhost:3000`，通过工作台完成 Excel 导入、两阶段检测、进度查看和结果导出。

**Architecture:** 保留现有 CLI 与 `classifier.js`、`excel.js`、`detector.js` 核心能力，新增本地 HTTP 服务、任务管理、两阶段队列、Cookie 管理、HTTP detail API 快筛和静态前端工作台。第一阶段使用 Cookie + HTTP detail API 快筛，默认并发 `5`；第二阶段只对待确认、API 异常、风控疑似项进入 Playwright 兜底，默认并发先 `2`，不稳定降为 `1`。

**Tech Stack:** Node.js ESM、原生 `node:http`/`node:fs`/`node:test`、ExcelJS、p-limit、Playwright、静态 HTML/CSS/JavaScript、PowerShell/Windows 批处理。

---

## 执行总原则

- 所有实现回答、文档、页面文案、日志和注释使用中文。
- 不修改 `D:\hongye\douyin_url\methods\python_playwright_dom_text`。
- 不删除现有 CLI；`node src/main.js` 继续可用。
- 不使用 `networkidle`，检测等待继续采用 `domcontentloaded` 加固定等待或显式轮询。
- 不在 UI、日志、测试快照或导出文件中输出 Cookie 明文。
- 本计划所有任务执行时不要求真实 git commit；每个任务结束记录“修改文件和验证命令”。
- 真实抖音网络检测不属于本计划默认验收，默认只运行语法检查、单元测试、本地 mock 集成测试和本地 UI 验收。
- 后续代码工作必须由主智能体调度，子智能体开发，规格审查，代码质量审查，有问题打回。

## 目标文件结构

```text
methods/node_detail_api/
  package.json                         # 修改：新增 UI 服务脚本和语法检查范围
  run.bat                              # 修改：双击启动本地 Web UI 服务并打开 3000
  README.md                            # 修改：补充 UI 服务运行说明
  src/
    main.js                            # 保留 CLI 入口
    config.js                          # 修改：增加 UI、API 快筛、兜底默认配置
    classifier.js                      # 修改：补充 API 快筛形态与风控判定覆盖
    excel.js                           # 修改：增加 Web 任务导出适配函数
    detector.js                        # 修改：抽出 Playwright 兜底可复用入口
    url-utils.js                       # 新增：抖音 URL 类型和作品 ID 提取
    api-detector.js                    # 新增：Cookie + HTTP detail API 快筛
    cookie-store.js                    # 新增：Cookie 状态、读写、刷新流程封装
    queue.js                           # 新增：两阶段并发、限速、停止和降级
    task-manager.js                    # 新增：任务生命周期、进度、统计、日志、结果
    web-server.js                      # 新增：本地 HTTP API 与静态资源托管
    start-web.js                       # 新增：Web UI 服务启动入口
  web/
    index.html                         # 新增：工作台页面
    app.js                             # 新增：前端状态、轮询、上传、停止、导出
    styles.css                         # 新增：工作型 UI 样式
  test/
    config.test.js                     # 新增
    url-utils.test.js                  # 新增
    api-detector.test.js               # 新增
    cookie-store.test.js               # 新增
    queue.test.js                      # 新增
    task-manager.test.js               # 新增
    web-server.test.js                 # 新增
    web-static.test.js                 # 新增
    excel-web-export.test.js           # 新增
    fallback-integration.test.js       # 新增
  docs/
    ui-service-设计文档.md             # 已存在
    ui-service-实现计划.md             # 本计划
    子智能体处理记录.md                # 每个子智能体追加记录
```

### Task 1: 测试与配置基础扩展

**Files:**
- Modify: `methods/node_detail_api/package.json`
- Modify: `methods/node_detail_api/src/config.js`
- Create: `methods/node_detail_api/test/config.test.js`
- Append: `methods/node_detail_api/docs/子智能体处理记录.md`

- [ ] **Step 1: 写失败测试**

在 `test/config.test.js` 写入配置默认值测试：

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_API_OPTIONS,
  DEFAULT_FALLBACK_OPTIONS,
  DEFAULT_UI_SERVICE,
  getUiServiceConfig
} from "../src/config.js";

test("UI 服务默认监听 3000 且不静默切换端口", () => {
  assert.equal(DEFAULT_UI_SERVICE.host, "127.0.0.1");
  assert.equal(DEFAULT_UI_SERVICE.port, 3000);
  assert.equal(DEFAULT_UI_SERVICE.openBrowser, true);
});

test("两阶段检测默认并发符合设计文档", () => {
  assert.equal(DEFAULT_API_OPTIONS.concurrency, 5);
  assert.equal(DEFAULT_API_OPTIONS.delayMs, 1000);
  assert.equal(DEFAULT_API_OPTIONS.timeoutMs, 15000);
  assert.equal(DEFAULT_FALLBACK_OPTIONS.concurrency, 2);
  assert.equal(DEFAULT_FALLBACK_OPTIONS.delayMs, 1000);
  assert.equal(DEFAULT_FALLBACK_OPTIONS.timeoutMs, 15000);
});

test("getUiServiceConfig 支持环境变量覆盖但保持数字校验", () => {
  const config = getUiServiceConfig({ UI_PORT: "3000", UI_HOST: "127.0.0.1" });
  assert.deepEqual(config, {
    host: "127.0.0.1",
    port: 3000,
    openBrowser: true
  });
});

test("getUiServiceConfig 拒绝非法端口", () => {
  assert.throws(
    () => getUiServiceConfig({ UI_PORT: "abc" }),
    /UI_PORT 必须是 1 到 65535 之间的整数/
  );
});
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `cmd /c npm test -- test/config.test.js`

Expected: FAIL，错误包含 `DEFAULT_API_OPTIONS` 或 `getUiServiceConfig` 未导出。

- [ ] **Step 3: 扩展配置导出**

在 `src/config.js` 增加以下导出，保留现有 `DEFAULT_OPTIONS` 给 CLI 使用：

```js
export const DEFAULT_UI_SERVICE = {
  host: "127.0.0.1",
  port: 3000,
  openBrowser: true
};

export const DEFAULT_API_OPTIONS = {
  concurrency: 5,
  delayMs: 1000,
  timeoutMs: 15000
};

export const DEFAULT_FALLBACK_OPTIONS = {
  concurrency: 2,
  delayMs: 1000,
  timeoutMs: 15000,
  waitAfterLoadMs: DEFAULT_OPTIONS.waitAfterLoadMs
};

export function getUiServiceConfig(env = process.env) {
  const port = env.UI_PORT === undefined ? DEFAULT_UI_SERVICE.port : Number.parseInt(env.UI_PORT, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("UI_PORT 必须是 1 到 65535 之间的整数。");
  }

  return {
    host: env.UI_HOST || DEFAULT_UI_SERVICE.host,
    port,
    openBrowser: env.UI_OPEN_BROWSER === "0" ? false : DEFAULT_UI_SERVICE.openBrowser
  };
}
```

- [ ] **Step 4: 更新 package 脚本**

将 `package.json` 脚本调整为：

```json
{
  "scripts": {
    "start": "node src/start-web.js",
    "start:cli": "node src/main.js",
    "check": "node --check src/main.js && node --check src/start-web.js && node --check src/web-server.js && node --check src/task-manager.js && node --check src/queue.js && node --check src/api-detector.js && node --check src/cookie-store.js && node --check src/url-utils.js && node --check src/detector.js && node --check src/classifier.js && node --check src/excel.js && node --check src/config.js && node --check test/*.test.js",
    "test": "node --test",
    "test:unit": "node --test test/*.test.js"
  }
}
```

- [ ] **Step 5: 运行配置测试和全量语法检查**

Run: `cmd /c npm test -- test/config.test.js`

Expected: PASS，4 个配置测试通过。

Run: `cmd /c npm run check`

Expected: 如果后续文件尚未创建，当前任务可先将 `check` 脚本限定为已存在文件；在任务 10 前必须恢复为完整脚本并通过。

- [ ] **Step 6: 规格审查点**

审查 `DEFAULT_API_OPTIONS.concurrency === 5`、`DEFAULT_FALLBACK_OPTIONS.concurrency === 2`、`DEFAULT_UI_SERVICE.port === 3000`，确认与设计文档一致。

- [ ] **Step 7: 代码质量审查点**

确认没有读取真实网络、没有启动浏览器、没有修改旧 Python 目录；确认配置函数不在模块顶层抛出环境依赖错误。

- [ ] **Step 8: 记录修改文件和验证命令**

在 `docs/子智能体处理记录.md` 追加本任务修改文件、执行命令、PASS/FAIL 结果和遗留风险。

### Task 2: HTTP API 快筛模块

**Files:**
- Create: `methods/node_detail_api/src/url-utils.js`
- Create: `methods/node_detail_api/src/api-detector.js`
- Modify: `methods/node_detail_api/src/classifier.js`
- Create: `methods/node_detail_api/test/url-utils.test.js`
- Create: `methods/node_detail_api/test/api-detector.test.js`
- Modify: `methods/node_detail_api/test/classifier.test.js`
- Append: `methods/node_detail_api/docs/子智能体处理记录.md`

- [ ] **Step 1: 写 URL 工具失败测试**

在 `test/url-utils.test.js` 写入：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { extractDouyinWorkInfo, isSupportedDouyinUrl } from "../src/url-utils.js";

test("extractDouyinWorkInfo 识别 video 链接", () => {
  assert.deepEqual(extractDouyinWorkInfo("https://www.douyin.com/video/7646781280897958638"), {
    supported: true,
    type: "视频",
    pathType: "video",
    workId: "7646781280897958638"
  });
});

test("extractDouyinWorkInfo 识别 note 链接", () => {
  assert.deepEqual(extractDouyinWorkInfo("https://www.douyin.com/note/7336500551691062538"), {
    supported: true,
    type: "图文",
    pathType: "note",
    workId: "7336500551691062538"
  });
});

test("extractDouyinWorkInfo 识别 share video 链接", () => {
  assert.equal(
    extractDouyinWorkInfo("https://www.douyin.com/share/video/7653287940747508965").workId,
    "7653287940747508965"
  );
});

test("isSupportedDouyinUrl 拒绝非抖音作品链接", () => {
  assert.equal(isSupportedDouyinUrl("https://example.com/video/123"), false);
  assert.equal(extractDouyinWorkInfo("https://example.com/video/123").supported, false);
});
```

- [ ] **Step 2: 写 API 快筛失败测试**

在 `test/api-detector.test.js` 写入：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildDetailApiCandidates, createApiDetector, isRiskApiPayload } from "../src/api-detector.js";

test("buildDetailApiCandidates 为作品 ID 生成明确 detail API 候选地址", () => {
  const urls = buildDetailApiCandidates({ workId: "123", pathType: "video" });
  assert.ok(urls.some((url) => url.includes("aweme/v1/web/aweme/detail")));
  assert.ok(urls.every((url) => url.includes("aweme_id=123") || url.includes("item_id=123")));
});

test("createApiDetector 注入 Cookie 和真实 UA 并返回结构化证据", async () => {
  const calls = [];
  const detector = createApiDetector({
    cookieHeader: "sessionid=abc;",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        aweme_detail: {
          aweme_id: "123",
          desc: "测试视频",
          video: { play_addr: { url_list: ["https://example.test/v.mp4"] } },
          statistics: { digg_count: 1 }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const evidence = await detector.detect("https://www.douyin.com/video/123");

  assert.equal(evidence.stage, "api");
  assert.equal(evidence.originalUrl, "https://www.douyin.com/video/123");
  assert.equal(evidence.detailJson.aweme_detail.aweme_id, "123");
  assert.match(calls[0].options.headers.cookie, /sessionid=abc/);
  assert.match(calls[0].options.headers["user-agent"], /Chrome/);
});

test("createApiDetector 遇到不支持 URL 返回待兜底证据", async () => {
  const detector = createApiDetector({ fetchImpl: async () => assert.fail("不应访问网络") });
  const evidence = await detector.detect("https://example.com/a");

  assert.equal(evidence.needsFallback, true);
  assert.equal(evidence.errorType, "unsupported_url");
  assert.match(evidence.error, /不属于支持的抖音作品链接/);
});

test("isRiskApiPayload 识别登录验证码和访问频繁", () => {
  assert.equal(isRiskApiPayload({ status_msg: "请先登录" }), true);
  assert.equal(isRiskApiPayload({ message: "访问过于频繁，请稍后再试" }), true);
  assert.equal(isRiskApiPayload({ status_msg: "作品不存在" }), false);
});
```

- [ ] **Step 3: 运行测试确认红灯**

Run: `cmd /c npm test -- test/url-utils.test.js test/api-detector.test.js`

Expected: FAIL，错误包含 `url-utils.js` 或 `api-detector.js` 不存在。

- [ ] **Step 4: 实现 URL 工具最小功能**

在 `src/url-utils.js` 导出：

```js
export function isSupportedDouyinUrl(url) {
  return extractDouyinWorkInfo(url).supported;
}

export function extractDouyinWorkInfo(url) {
  const text = String(url || "");
  const match = text.match(/douyin\.com\/(?:share\/video|video|note)\/([A-Za-z0-9_-]+)/);
  if (!match) {
    return { supported: false, type: "未知", pathType: "unknown", workId: "" };
  }

  const pathType = text.includes("/note/") ? "note" : "video";
  return {
    supported: true,
    type: pathType === "note" ? "图文" : "视频",
    pathType,
    workId: match[1]
  };
}
```

- [ ] **Step 5: 实现 API 快筛最小功能**

在 `src/api-detector.js` 导出：

```js
import { BROWSER_USER_AGENT, DEFAULT_API_OPTIONS } from "./config.js";
import { extractDouyinWorkInfo } from "./url-utils.js";

export function buildDetailApiCandidates(info) {
  return [
    `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(info.workId)}`,
    `https://www.douyin.com/aweme/v1/web/multi/aweme/detail/?aweme_ids=%5B${encodeURIComponent(info.workId)}%5D`,
    `https://www.douyin.com/aweme/v1/web/note/detail/?item_id=${encodeURIComponent(info.workId)}`
  ];
}

export function createApiDetector(options = {}) {
  const config = { ...DEFAULT_API_OPTIONS, ...options };
  const fetchImpl = config.fetchImpl || fetch;

  return {
    async detect(url) {
      const info = extractDouyinWorkInfo(url);
      const startedAt = new Date();
      if (!info.supported) {
        return {
          stage: "api",
          originalUrl: url,
          finalUrl: url,
          detailJson: null,
          needsFallback: true,
          errorType: "unsupported_url",
          error: "不属于支持的抖音作品链接。",
          startedAt,
          finishedAt: new Date()
        };
      }

      for (const apiUrl of buildDetailApiCandidates(info)) {
        const response = await fetchImpl(apiUrl, {
          method: "GET",
          headers: {
            "user-agent": BROWSER_USER_AGENT,
            "accept": "application/json,text/plain,*/*",
            "cookie": config.cookieHeader || "",
            "referer": url
          }
        });
        const detailJson = await response.json();
        return {
          stage: "api",
          originalUrl: url,
          finalUrl: url,
          apiUrl,
          detailJson,
          needsFallback: isRiskApiPayload(detailJson),
          error: "",
          startedAt,
          finishedAt: new Date()
        };
      }
    }
  };
}

export function isRiskApiPayload(payload) {
  const text = JSON.stringify(payload || {});
  return ["验证码", "登录", "请先登录", "安全验证", "访问过于频繁", "稍后再试", "captcha", "verify"]
    .some((keyword) => text.toLowerCase().includes(keyword.toLowerCase()));
}
```

- [ ] **Step 6: 补充分类器 HTTP 风控测试**

在 `test/classifier.test.js` 增加测试：

```js
test("HTTP API 返回登录或风控文案时保持待确认", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/video/123",
    finalUrl: "https://www.douyin.com/video/123",
    detailJson: {
      status_code: 2149,
      status_msg: "请先登录后继续访问"
    }
  });

  assert.equal(result.status, "待确认");
  assert.equal(result.contentType, "视频");
  assert.equal(result.basis, "detail_api");
});
```

- [ ] **Step 7: 运行快筛测试**

Run: `cmd /c npm test -- test/url-utils.test.js test/api-detector.test.js test/classifier.test.js`

Expected: PASS，URL 提取、API 快筛 mock 和分类器风控测试通过。

- [ ] **Step 8: 规格审查点**

审查 `buildDetailApiCandidates()` 不能使用过宽 `note` 或裸 `detail` 关键词；审查 API 异常、风控疑似、无法提取 ID 都能进入兜底队列。

- [ ] **Step 9: 代码质量审查点**

确认测试全部使用 mock `fetchImpl`，未访问真实抖音；确认 `cookieHeader` 不进入错误消息和测试断言输出之外的日志。

- [ ] **Step 10: 记录修改文件和验证命令**

追加处理记录，说明未运行真实网络检测。

### Task 3: Cookie 管理模块

**Files:**
- Create: `methods/node_detail_api/src/cookie-store.js`
- Create: `methods/node_detail_api/test/cookie-store.test.js`
- Modify: `methods/node_detail_api/.gitignore`（如果文件不存在则创建）
- Append: `methods/node_detail_api/docs/子智能体处理记录.md`

- [ ] **Step 1: 写 Cookie 管理失败测试**

在 `test/cookie-store.test.js` 写入：

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createCookieStore,
  maskCookieSummary,
  normalizeCookies
} from "../src/cookie-store.js";

test("normalizeCookies 将 Playwright cookies 转为请求头字符串", () => {
  assert.equal(
    normalizeCookies([
      { name: "sessionid", value: "abc", domain: ".douyin.com" },
      { name: "ttwid", value: "xyz", domain: ".douyin.com" }
    ]),
    "sessionid=abc; ttwid=xyz"
  );
});

test("maskCookieSummary 不泄露 Cookie 明文", () => {
  const summary = maskCookieSummary("sessionid=abcdef; ttwid=xyz");
  assert.equal(summary.includes("abcdef"), false);
  assert.match(summary, /2 个 Cookie/);
});

test("createCookieStore 保存和读取本地 Cookie 状态", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-cookie-"));
  const store = createCookieStore({ storagePath: path.join(dir, "cookies.json") });

  await store.saveCookieHeader("sessionid=abc; ttwid=xyz");
  const status = await store.getStatus();
  const cookieHeader = await store.getCookieHeader();

  assert.equal(status.exists, true);
  assert.equal(status.summary, "2 个 Cookie");
  assert.equal(cookieHeader, "sessionid=abc; ttwid=xyz");
});
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `cmd /c npm test -- test/cookie-store.test.js`

Expected: FAIL，错误包含 `cookie-store.js` 不存在。

- [ ] **Step 3: 实现 Cookie 存储接口**

在 `src/cookie-store.js` 导出：

```js
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_COOKIE_PATH = path.resolve(process.cwd(), ".local", "cookies.json");

export function createCookieStore(options = {}) {
  const storagePath = options.storagePath || DEFAULT_COOKIE_PATH;

  return {
    storagePath,
    async getStatus() {
      const cookieHeader = await readCookieHeader(storagePath);
      return {
        exists: Boolean(cookieHeader),
        storagePath,
        summary: maskCookieSummary(cookieHeader),
        refreshedAt: cookieHeader ? (await readCookieFile(storagePath)).refreshedAt : ""
      };
    },
    async getCookieHeader() {
      return readCookieHeader(storagePath);
    },
    async saveCookieHeader(cookieHeader) {
      await fs.mkdir(path.dirname(storagePath), { recursive: true });
      await fs.writeFile(storagePath, JSON.stringify({
        cookieHeader,
        refreshedAt: new Date().toISOString()
      }, null, 2), "utf8");
    }
  };
}

export function normalizeCookies(cookies = []) {
  return cookies
    .filter((cookie) => cookie?.name && cookie?.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function maskCookieSummary(cookieHeader = "") {
  const count = String(cookieHeader).split(";").map((item) => item.trim()).filter(Boolean).length;
  return count > 0 ? `${count} 个 Cookie` : "未保存 Cookie";
}

async function readCookieHeader(storagePath) {
  const data = await readCookieFile(storagePath);
  return data.cookieHeader || "";
}

async function readCookieFile(storagePath) {
  try {
    return JSON.parse(await fs.readFile(storagePath, "utf8"));
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: 忽略本地 Cookie 文件**

在 `methods/node_detail_api/.gitignore` 确保包含：

```gitignore
.local/
uploads/
```

- [ ] **Step 5: 运行 Cookie 测试**

Run: `cmd /c npm test -- test/cookie-store.test.js`

Expected: PASS，3 个测试通过。

- [ ] **Step 6: 规格审查点**

确认 Cookie 存储路径为本机本地文件；确认 UI 接口只返回 `exists`、`summary`、`refreshedAt`，不返回明文。

- [ ] **Step 7: 代码质量审查点**

确认没有把 Cookie 写入 `console.log`；确认测试临时目录使用 `os.tmpdir()`，不会污染项目数据。

- [ ] **Step 8: 记录修改文件和验证命令**

追加处理记录，记录 `.local/` 已加入忽略规则。

### Task 4: 任务队列与任务管理模块

**Files:**
- Create: `methods/node_detail_api/src/queue.js`
- Create: `methods/node_detail_api/src/task-manager.js`
- Create: `methods/node_detail_api/test/queue.test.js`
- Create: `methods/node_detail_api/test/task-manager.test.js`
- Append: `methods/node_detail_api/docs/子智能体处理记录.md`

- [ ] **Step 1: 写队列失败测试**

在 `test/queue.test.js` 写入：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createTwoStageQueue } from "../src/queue.js";

test("API 明确结果不进入 Playwright 兜底", async () => {
  const fallbackCalls = [];
  const queue = createTwoStageQueue({
    apiConcurrency: 2,
    fallbackConcurrency: 1,
    apiDetect: async (row) => ({ rowNumber: row.rowNumber, status: "存活", basis: "detail_api", needsFallback: false }),
    fallbackDetect: async (row) => fallbackCalls.push(row)
  });

  const results = await queue.run([{ rowNumber: 2, url: "https://www.douyin.com/video/123" }]);

  assert.equal(results[0].status, "存活");
  assert.equal(fallbackCalls.length, 0);
});

test("API 待确认结果进入 Playwright 兜底", async () => {
  const queue = createTwoStageQueue({
    apiConcurrency: 1,
    fallbackConcurrency: 1,
    apiDetect: async (row) => ({ rowNumber: row.rowNumber, status: "待确认", basis: "detail_api", needsFallback: true }),
    fallbackDetect: async (row) => ({ rowNumber: row.rowNumber, status: "失效", basis: "dom_text" })
  });

  const results = await queue.run([{ rowNumber: 3, url: "https://www.douyin.com/note/404" }]);

  assert.equal(results[0].status, "失效");
  assert.equal(results[0].basis, "dom_text");
});

test("stop 后不再启动新项目", async () => {
  let calls = 0;
  const queue = createTwoStageQueue({
    apiConcurrency: 1,
    fallbackConcurrency: 1,
    apiDetect: async (row, controls) => {
      calls += 1;
      controls.stop();
      return { rowNumber: row.rowNumber, status: "待确认", basis: "stopped", needsFallback: false };
    },
    fallbackDetect: async () => assert.fail("停止后不应进入兜底")
  });

  const results = await queue.run([
    { rowNumber: 2, url: "https://www.douyin.com/video/1" },
    { rowNumber: 3, url: "https://www.douyin.com/video/2" }
  ]);

  assert.equal(calls, 1);
  assert.equal(results.length, 2);
  assert.equal(results[1].status, "跳过");
  assert.match(results[1].remark, /任务停止未检测/);
});
```

- [ ] **Step 2: 写任务管理失败测试**

在 `test/task-manager.test.js` 写入：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createTaskManager } from "../src/task-manager.js";

test("createTaskManager 创建任务并维护中文状态和统计", async () => {
  const manager = createTaskManager({
    runQueue: async ({ rows, onResult }) => {
      onResult({ rowNumber: rows[0].rowNumber, status: "存活", basis: "detail_api" });
      return [{ rowNumber: rows[0].rowNumber, status: "存活", basis: "detail_api" }];
    }
  });

  const task = await manager.createTask({
    inputPath: "input.xlsx",
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/123" }],
    options: { apiConcurrency: 5, fallbackConcurrency: 2 }
  });
  await manager.startTask(task.id);
  const snapshot = manager.getTask(task.id);

  assert.equal(snapshot.status, "已完成");
  assert.equal(snapshot.stats.total, 1);
  assert.equal(snapshot.stats.alive, 1);
  assert.equal(snapshot.logs.length > 0, true);
});

test("任务日志最多保留最近 200 条", () => {
  const manager = createTaskManager({ runQueue: async () => [] });
  const task = manager.createMemoryTaskForTest({ rows: [] });

  for (let index = 0; index < 250; index += 1) {
    manager.addLog(task.id, "信息", `日志 ${index}`);
  }

  assert.equal(manager.getTask(task.id).logs.length, 200);
});
```

- [ ] **Step 3: 运行测试确认红灯**

Run: `cmd /c npm test -- test/queue.test.js test/task-manager.test.js`

Expected: FAIL，错误包含 `queue.js` 或 `task-manager.js` 不存在。

- [ ] **Step 4: 实现队列接口**

在 `src/queue.js` 导出：

```js
import pLimit from "p-limit";
import { formatLocalDateTime } from "./excel.js";

export function createTwoStageQueue(options) {
  const controls = createControls();
  const apiLimit = pLimit(options.apiConcurrency || 5);
  const fallbackLimit = pLimit(options.fallbackConcurrency || 2);

  return {
    controls,
    async run(rows = []) {
      const results = [];
      const fallbackRows = [];

      for (const row of rows) {
        if (controls.stopped) {
          results.push(buildStoppedResult(row));
          continue;
        }
        const apiResult = await apiLimit(() => options.apiDetect(row, controls));
        if (apiResult?.needsFallback) {
          fallbackRows.push(row);
        } else {
          results.push({ ...apiResult, checkedAt: apiResult.checkedAt || formatLocalDateTime() });
        }
      }

      for (const row of fallbackRows) {
        if (controls.stopped) {
          results.push(buildStoppedResult(row));
          continue;
        }
        const fallbackResult = await fallbackLimit(() => options.fallbackDetect(row, controls));
        results.push({ ...fallbackResult, checkedAt: fallbackResult.checkedAt || formatLocalDateTime() });
      }

      return results;
    },
    stop: controls.stop
  };
}

function createControls() {
  return {
    stopped: false,
    stop() {
      this.stopped = true;
    }
  };
}

function buildStoppedResult(row) {
  return {
    rowNumber: row.rowNumber,
    status: "跳过",
    finalUrl: row.url || "",
    remark: "任务停止未检测",
    checkedAt: formatLocalDateTime(),
    basis: "stopped"
  };
}
```

- [ ] **Step 5: 实现任务管理接口**

在 `src/task-manager.js` 导出：

```js
import { randomUUID } from "node:crypto";

export function createTaskManager(options) {
  const tasks = new Map();
  const runQueue = options.runQueue;

  function createTask(payload) {
    const task = buildTask(payload);
    tasks.set(task.id, task);
    addLog(task.id, "信息", "任务已创建。");
    return task;
  }

  return {
    async createTask(payload) {
      return createTask(payload);
    },
    createMemoryTaskForTest(payload) {
      return createTask(payload);
    },
    async startTask(id) {
      const task = requireTask(tasks, id);
      task.status = "检测中";
      addLog(id, "信息", "任务开始检测。");
      const results = await runQueue({
        rows: task.rows,
        options: task.options,
        onResult: (result) => applyResult(task, result)
      });
      for (const result of results) {
        applyResult(task, result);
      }
      task.status = task.stopRequested ? "已停止" : "已完成";
      addLog(id, "信息", `任务${task.status}。`);
      return snapshotTask(task);
    },
    stopTask(id) {
      const task = requireTask(tasks, id);
      task.stopRequested = true;
      task.status = "停止中";
      addLog(id, "警告", "已请求停止任务。");
      return snapshotTask(task);
    },
    getTask(id) {
      return snapshotTask(requireTask(tasks, id));
    },
    addLog
  };

  function addLog(id, level, message) {
    const task = requireTask(tasks, id);
    task.logs.push({ time: new Date().toISOString(), level, message });
    task.logs = task.logs.slice(-200);
  }
}

function buildTask(payload) {
  return {
    id: randomUUID(),
    status: "等待中",
    inputPath: payload.inputPath || "",
    outputPath: "",
    rows: payload.rows || [],
    options: payload.options || {},
    stats: { total: (payload.rows || []).length, processed: 0, alive: 0, invalid: 0, uncertain: 0, skipped: 0, failed: 0, apiHit: 0, fallback: 0 },
    results: [],
    logs: [],
    stopRequested: false
  };
}

function applyResult(task, result) {
  if (task.results.some((item) => item.rowNumber === result.rowNumber)) {
    return;
  }
  task.results.push(result);
  task.stats.processed += 1;
  if (result.status === "存活") task.stats.alive += 1;
  else if (result.status === "失效") task.stats.invalid += 1;
  else if (result.status === "待确认") task.stats.uncertain += 1;
  else if (result.status === "跳过") task.stats.skipped += 1;
  else task.stats.failed += 1;
  if (result.basis === "detail_api") task.stats.apiHit += 1;
  if (result.basis === "dom_text" || result.stage === "fallback") task.stats.fallback += 1;
}

function snapshotTask(task) {
  return JSON.parse(JSON.stringify(task));
}

function requireTask(tasks, id) {
  const task = tasks.get(id);
  if (!task) throw new Error("任务不存在。");
  return task;
}
```

- [ ] **Step 6: 运行队列和任务测试**

Run: `cmd /c npm test -- test/queue.test.js test/task-manager.test.js`

Expected: PASS，队列入队、停止、任务统计和日志环形缓冲通过。

- [ ] **Step 7: 规格审查点**

确认 API 明确存活/失效不进入兜底；确认待确认/API 异常/风控疑似进入兜底；确认停止语义是“请求停止”而不是强杀。

- [ ] **Step 8: 代码质量审查点**

确认队列测试使用 fake detector；确认结果按 `rowNumber` 去重；确认任务快照不暴露内部可变对象。

- [ ] **Step 9: 记录修改文件和验证命令**

追加处理记录，记录当前队列实现是否已覆盖风控降级；未覆盖时说明由任务 8 完成。

### Task 5: 本地 Web 服务和 run.bat 启动

**Files:**
- Create: `methods/node_detail_api/src/web-server.js`
- Create: `methods/node_detail_api/src/start-web.js`
- Modify: `methods/node_detail_api/package.json`
- Modify: `methods/node_detail_api/run.bat`
- Create: `methods/node_detail_api/test/web-server.test.js`
- Append: `methods/node_detail_api/docs/子智能体处理记录.md`

- [ ] **Step 1: 写 Web 服务失败测试**

在 `test/web-server.test.js` 写入：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createWebServer } from "../src/web-server.js";

test("GET /api/health 返回中文健康状态", async () => {
  const app = createWebServer({
    version: "0.1.0-test",
    taskManager: {},
    cookieStore: { getStatus: async () => ({ exists: false, summary: "未保存 Cookie" }) }
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  const json = await response.json();
  server.close();

  assert.equal(response.status, 200);
  assert.equal(json.status, "正常");
  assert.equal(json.port > 0, true);
  assert.equal(json.version, "0.1.0-test");
});

test("未知 API 返回中文 404", async () => {
  const app = createWebServer({ version: "test" });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/missing`);
  const json = await response.json();
  server.close();

  assert.equal(response.status, 404);
  assert.match(json.error, /接口不存在/);
});
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `cmd /c npm test -- test/web-server.test.js`

Expected: FAIL，错误包含 `web-server.js` 不存在。

- [ ] **Step 3: 实现本地 HTTP 服务骨架**

在 `src/web-server.js` 导出：

```js
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

export function createWebServer(deps = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/api/health") {
        return sendJson(res, 200, {
          status: "正常",
          version: deps.version || "0.1.0",
          port: req.socket.localPort,
          cookie: deps.cookieStore?.getStatus ? await deps.cookieStore.getStatus() : { exists: false, summary: "未配置 Cookie 存储" }
        });
      }
      if (req.method === "GET" && url.pathname === "/") {
        return sendStatic(res, path.resolve(process.cwd(), "web", "index.html"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/app.js") {
        return sendStatic(res, path.resolve(process.cwd(), "web", "app.js"), "text/javascript; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/styles.css") {
        return sendStatic(res, path.resolve(process.cwd(), "web", "styles.css"), "text/css; charset=utf-8");
      }
      return sendJson(res, 404, { error: "接口不存在。" });
    } catch (error) {
      return sendJson(res, 500, { error: `服务处理失败：${error.message}` });
    }
  });
}

export function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function sendStatic(res, filePath, contentType) {
  const body = await fs.readFile(filePath);
  res.writeHead(200, { "content-type": contentType });
  res.end(body);
}
```

- [ ] **Step 4: 实现启动入口**

在 `src/start-web.js` 写入：

```js
import { execFile } from "node:child_process";
import { createCookieStore } from "./cookie-store.js";
import { getUiServiceConfig } from "./config.js";
import { createTaskManager } from "./task-manager.js";
import { createWebServer } from "./web-server.js";

const config = getUiServiceConfig();
const cookieStore = createCookieStore();
const taskManager = createTaskManager({ runQueue: async () => [] });
const server = createWebServer({ version: "0.1.0", cookieStore, taskManager });

server.listen(config.port, config.host, () => {
  const url = `http://localhost:${config.port}`;
  console.log(`本地 Web UI 服务已启动：${url}`);
  if (config.openBrowser) {
    execFile("cmd", ["/c", "start", "", url], { windowsHide: true });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${config.port} 已被占用，请释放端口后重新启动。`);
  } else {
    console.error(`本地 Web UI 服务启动失败：${error.message}`);
  }
  process.exitCode = 1;
});
```

- [ ] **Step 5: 修改 run.bat 启动 UI**

将 `run.bat` 最后的 CLI 执行段改为：

```bat
cmd /c npm run check
if errorlevel 1 (
  echo 依赖或源码检查失败。
  echo 如依赖缺失，请执行：cmd /c npm install
  pause
  exit /b 1
)

echo 正在启动本地 Web UI 服务：http://localhost:3000
cmd /c npm start
echo.
pause
```

- [ ] **Step 6: 运行 Web 服务测试**

Run: `cmd /c npm test -- test/web-server.test.js`

Expected: PASS，健康检查和 404 测试通过。

- [ ] **Step 7: 启动命令语法检查**

Run: `cmd /c npm run check`

Expected: PASS，`src/start-web.js`、`src/web-server.js`、现有源码和测试文件语法检查通过。

- [ ] **Step 8: 规格审查点**

确认 `run.bat` 启动的是 `http://localhost:3000`；确认端口占用时不静默切换端口；确认 `node src/main.js` CLI 仍可执行。

- [ ] **Step 9: 代码质量审查点**

确认 `start-web.js` 只监听本地地址；确认错误消息中文；确认未引入新依赖。

- [ ] **Step 10: 记录修改文件和验证命令**

追加处理记录，注明未双击真实运行 `run.bat` 时需要在最终验收补跑本地启动。

### Task 6: 前端工作台 UI

**Files:**
- Create: `methods/node_detail_api/web/index.html`
- Create: `methods/node_detail_api/web/app.js`
- Create: `methods/node_detail_api/web/styles.css`
- Create: `methods/node_detail_api/test/web-static.test.js`
- Append: `methods/node_detail_api/docs/子智能体处理记录.md`

- [ ] **Step 1: 写静态 UI 失败测试**

在 `test/web-static.test.js` 写入：

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("工作台首屏包含任务面板、统计、日志和结果表格", async () => {
  const html = await fs.readFile("web/index.html", "utf8");

  assert.match(html, /抖音链接检测工作台/);
  assert.match(html, /id="fileInput"/);
  assert.match(html, /API 快筛并发/);
  assert.match(html, /Playwright 兜底并发/);
  assert.match(html, /任务日志/);
  assert.match(html, /结果预览/);
});

test("前端脚本暴露纯函数用于格式化统计和状态", async () => {
  const module = await import("../web/app.js");

  assert.equal(module.formatTaskStatus({ status: "检测中" }), "检测中");
  assert.equal(module.formatTaskStatus(null), "未创建任务");
  assert.equal(module.buildQuery({ page: 2, pageSize: 50 }), "page=2&pageSize=50");
});

test("样式文件不使用 landing page hero 文案", async () => {
  const html = await fs.readFile("web/index.html", "utf8");
  assert.equal(/hero|立即体验|产品介绍/i.test(html), false);
});
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `cmd /c npm test -- test/web-static.test.js`

Expected: FAIL，错误包含 `web/index.html` 不存在。

- [ ] **Step 3: 创建工作台 HTML**

`web/index.html` 必须包含这些结构和 ID：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>抖音链接检测工作台</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="topbar">
    <h1>抖音链接检测工作台</h1>
    <div class="status-strip">
      <span id="serviceStatus">服务：检查中</span>
      <span id="cookieStatus">Cookie：检查中</span>
      <span id="taskStatus">任务：未创建</span>
      <a id="exportLink" class="button" href="#" aria-disabled="true">导出 Excel</a>
    </div>
  </header>
  <main class="workspace">
    <section class="task-panel" aria-label="任务面板">
      <label>选择 Excel<input id="fileInput" type="file" accept=".xlsx"></label>
      <label>API 快筛并发<input id="apiConcurrency" type="number" min="1" max="10" value="5"></label>
      <label>Playwright 兜底并发<input id="fallbackConcurrency" type="number" min="1" max="2" value="2"></label>
      <label>单项超时<input id="timeoutMs" type="number" min="3000" step="1000" value="15000"></label>
      <label>批次间隔<input id="delayMs" type="number" min="0" step="100" value="1000"></label>
      <label class="inline"><input id="enableFallback" type="checkbox" checked> 启用 Playwright 兜底</label>
      <button id="startButton" type="button">开始检测</button>
      <button id="stopButton" type="button" disabled>停止任务</button>
    </section>
    <section class="main-panel">
      <div id="statsGrid" class="stats-grid"></div>
      <section>
        <h2>结果预览</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>行号</th><th>原始链接</th><th>状态</th><th>内容类型</th><th>最终链接</th><th>备注</th><th>检测依据</th></tr></thead>
            <tbody id="resultsBody"></tbody>
          </table>
        </div>
      </section>
    </section>
    <aside class="log-panel">
      <h2>任务日志</h2>
      <div id="logList"></div>
    </aside>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 4: 创建前端脚本**

`web/app.js` 至少导出并使用：

```js
export function formatTaskStatus(task) {
  return task?.status || "未创建任务";
}

export function buildQuery(params) {
  return new URLSearchParams(params).toString();
}

export function createInitialState() {
  return { taskId: "", polling: null, page: 1, pageSize: 50 };
}

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || "请求失败。");
  }
  return json;
}
```

浏览器执行时绑定 `fileInput`、`startButton`、`stopButton`、`exportLink`、`statsGrid`、`resultsBody`、`logList`，通过 `/api/health`、`/api/tasks`、`/api/tasks/:id`、`/api/tasks/:id/results` 完成短轮询。

- [ ] **Step 5: 创建工作型样式**

`web/styles.css` 使用中性工作台布局，必须包含：

```css
body {
  margin: 0;
  font-family: "Microsoft YaHei", Arial, sans-serif;
  background: #f6f7f9;
  color: #1f2933;
}

.workspace {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr) 320px;
  gap: 16px;
  padding: 16px;
}

.table-wrap {
  overflow: auto;
}

td, th {
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 6: 运行 UI 静态测试**

Run: `cmd /c npm test -- test/web-static.test.js`

Expected: PASS，静态结构、纯函数和 landing page 禁用检查通过。

- [ ] **Step 7: 规格审查点**

确认首屏是工作台，不是 landing page；确认默认参数 API 并发 `5`、兜底并发 `2`、超时 `15000`、间隔 `1000`。

- [ ] **Step 8: 代码质量审查点**

确认页面没有展示 Cookie 明文的元素；确认长链接不会挤压布局；确认不使用大幅 hero、装饰插画和过度渐变。

- [ ] **Step 9: 记录修改文件和验证命令**

追加处理记录，说明 UI 当前是否已接入真实任务接口；未接入的接口由任务 5 和任务 7 完成。

### Task 7: Excel 导出接入

**Files:**
- Modify: `methods/node_detail_api/src/excel.js`
- Modify: `methods/node_detail_api/src/task-manager.js`
- Modify: `methods/node_detail_api/src/web-server.js`
- Create: `methods/node_detail_api/test/excel-web-export.test.js`
- Append: `methods/node_detail_api/docs/子智能体处理记录.md`

- [ ] **Step 1: 写 Web 导出失败测试**

在 `test/excel-web-export.test.js` 写入：

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { exportTaskWorkbook, readInputWorkbook, OUTPUT_COLUMNS } from "../src/excel.js";

test("exportTaskWorkbook 基于原 workbook 追加既有中文结果列", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-web-export-"));
  const input = path.join(dir, "输入.xlsx");
  const output = path.join(dir, "output", "检测结果.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("主表");
  workbook.addWorksheet("说明").getCell("A1").value = "说明内容";
  sheet.addRow(["序号", "链接"]);
  sheet.addRow([1, "https://www.douyin.com/video/123"]);
  await workbook.xlsx.writeFile(input);

  const inputData = await readInputWorkbook(input);
  const result = await exportTaskWorkbook({
    outputPath: output,
    inputData,
    results: [{
      rowNumber: 2,
      status: "存活",
      finalUrl: "https://www.douyin.com/video/123",
      remark: "detail API 返回有效作品数据。",
      checkedAt: "2026-06-24 10:00:00",
      basis: "detail_api"
    }]
  });

  const exported = new ExcelJS.Workbook();
  await exported.xlsx.readFile(result.outputPath);
  assert.ok(exported.getWorksheet("说明"));
  assert.deepEqual(exported.getWorksheet("主表").getRow(1).values.slice(3), OUTPUT_COLUMNS);
});
```

- [ ] **Step 2: 运行测试确认红灯**

Run: `cmd /c npm test -- test/excel-web-export.test.js`

Expected: FAIL，错误包含 `exportTaskWorkbook` 未导出。

- [ ] **Step 3: 增加导出适配函数**

在 `src/excel.js` 导出：

```js
export async function exportTaskWorkbook({ outputPath, inputData, results }) {
  return writeOutputWorkbook(outputPath, inputData, results);
}
```

- [ ] **Step 4: 任务管理记录输入数据**

在 `task-manager.js` 的任务对象中保存 `inputData`、`inputPath`、`outputPath`，并提供：

```js
getTaskExportPayload(id) {
  const task = requireTask(tasks, id);
  return {
    outputPath: task.outputPath,
    inputData: task.inputData,
    results: task.results
  };
}
```

- [ ] **Step 5: Web 服务导出接口**

在 `web-server.js` 增加 `GET /api/tasks/:id/export`：

```js
if (req.method === "GET" && taskExportMatch) {
  const payload = deps.taskManager.getTaskExportPayload(taskExportMatch.groups.id);
  const exported = await deps.exportTaskWorkbook(payload);
  res.writeHead(200, {
    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "content-disposition": "attachment; filename*=UTF-8''%E6%A3%80%E6%B5%8B%E7%BB%93%E6%9E%9C.xlsx"
  });
  return createReadStream(exported.outputPath).pipe(res);
}
```

- [ ] **Step 6: 运行 Excel Web 导出测试**

Run: `cmd /c npm test -- test/excel-web-export.test.js test/excel.test.js`

Expected: PASS，Web 导出适配和既有 Excel 保真测试均通过。

- [ ] **Step 7: 规格审查点**

确认导出列仍为 `状态`、`最终链接`、`备注`、`检测时间`、`检测依据`，不额外写入未审查列。

- [ ] **Step 8: 代码质量审查点**

确认写出失败不会丢失内存结果；确认输出路径在 `output/` 下；确认仍基于输入 workbook 另存。

- [ ] **Step 9: 记录修改文件和验证命令**

追加处理记录，列出 Excel 保真测试结果。

### Task 8: Playwright 兜底接入

**Files:**
- Modify: `methods/node_detail_api/src/detector.js`
- Modify: `methods/node_detail_api/src/queue.js`
- Modify: `methods/node_detail_api/src/task-manager.js`
- Create: `methods/node_detail_api/test/fallback-integration.test.js`
- Append: `methods/node_detail_api/docs/子智能体处理记录.md`

- [ ] **Step 1: 写兜底集成失败测试**

在 `test/fallback-integration.test.js` 写入：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { classifyDetailResult } from "../src/classifier.js";
import { createTwoStageQueue } from "../src/queue.js";

test("API 异常后使用兜底证据重新分类", async () => {
  const queue = createTwoStageQueue({
    apiConcurrency: 1,
    fallbackConcurrency: 1,
    apiDetect: async (row) => ({
      rowNumber: row.rowNumber,
      originalUrl: row.url,
      status: "待确认",
      needsFallback: true,
      basis: "detail_api",
      error: "HTTP 请求超时"
    }),
    fallbackDetect: async (row) => {
      const evidence = {
        originalUrl: row.url,
        finalUrl: row.url,
        fallbackText: "你要观看的视频不存在"
      };
      const classified = classifyDetailResult(evidence);
      return {
        rowNumber: row.rowNumber,
        status: classified.status,
        contentType: classified.contentType,
        finalUrl: evidence.finalUrl,
        remark: classified.reason,
        basis: classified.basis,
        stage: "fallback"
      };
    }
  });

  const results = await queue.run([{ rowNumber: 2, url: "https://www.douyin.com/video/404" }]);

  assert.equal(results[0].status, "失效");
  assert.equal(results[0].basis, "dom_text");
});
```

- [ ] **Step 2: 运行测试确认当前状态**

Run: `cmd /c npm test -- test/fallback-integration.test.js`

Expected: PASS 或 FAIL；如果 FAIL，应只修复队列结果合并，不启动真实浏览器。

- [ ] **Step 3: 增加兜底适配函数**

在 `detector.js` 保留 `createDetailDetector()`，并新增轻量适配导出：

```js
export function createFallbackDetector(options = {}) {
  const detector = createDetailDetector(options);
  return {
    async detect(row) {
      const url = typeof row === "string" ? row : row.url;
      const evidence = await detector.detect(url);
      return {
        ...evidence,
        stage: "fallback",
        needsFallback: false
      };
    },
    close: detector.close
  };
}
```

- [ ] **Step 4: 任务管理接入真实兜底但测试用 fake**

在 `task-manager.js` 的生产组装层接收 `apiDetector`、`fallbackDetector`、`classifier`，测试继续注入 fake：

```js
createTaskManager({
  runQueue,
  apiDetector,
  fallbackDetector,
  classifyDetailResult
});
```

- [ ] **Step 5: 添加 networkidle 禁用检查**

Run: `rg "networkidle" methods\node_detail_api -g "!node_modules/**"`

Expected: 只允许命中文档中的禁用说明；源码不得命中 `networkidle`。

- [ ] **Step 6: 运行兜底相关测试**

Run: `cmd /c npm test -- test/fallback-integration.test.js test/detector.test.js test/classifier.test.js`

Expected: PASS，兜底路径、detector 非致命解析失败和分类器测试全部通过。

- [ ] **Step 7: 规格审查点**

确认只有待确认、API 异常、风控疑似项进入兜底；确认兜底遇到登录、验证码、访问频繁时输出 `待确认`。

- [ ] **Step 8: 代码质量审查点**

确认兜底 detector 生命周期最终关闭；确认测试不打开真实浏览器；确认非致命 JSON 解析失败不覆盖 DOM 明确结论。

- [ ] **Step 9: 记录修改文件和验证命令**

追加处理记录，记录 `rg "networkidle"` 结果。

### Task 9: 文档和 AGENTS 流程更新

**Files:**
- Modify: `D:\hongye\douyin_url\AGENTS.md`
- Modify: `methods/node_detail_api/README.md`
- Modify: `methods/node_detail_api/docs/run-bat-操作文档.md`
- Append: `methods/node_detail_api/docs/子智能体处理记录.md`

- [ ] **Step 1: 写文档审查命令**

Run: `rg "主智能体调度|子智能体开发|规格审查|代码质量审查|http://localhost:3000|networkidle|--limit" AGENTS.md methods\node_detail_api\README.md methods\node_detail_api\docs`

Expected: 能命中流程要求、UI 地址、`networkidle` 禁用说明和 `--limit` 正式禁用说明。

- [ ] **Step 2: 更新根 AGENTS 项目记忆**

在 `AGENTS.md` 追加或更新这些要点：

```markdown
- Web UI 本地服务目标入口为 `http://localhost:3000`，双击 `methods/node_detail_api/run.bat` 启动。
- 后续 UI 服务代码工作必须执行：主智能体调度、子智能体开发、规格审查、代码质量审查，有问题打回。
- UI 服务第一阶段 API 快筛默认并发 `5`；第二阶段 Playwright 兜底默认并发先 `2`，不稳定降为 `1`。
- UI 服务开发与验收默认不运行真实抖音网络检测；真实检测必须由用户明确要求。
- 全流程仍然不使用 `networkidle`。
```

- [ ] **Step 3: 更新 README**

在 `methods/node_detail_api/README.md` 补充：

```markdown
## 本地 Web UI 服务

```bash
cmd /c npm install
cmd /c npm start
```

启动后访问 `http://localhost:3000`。双击 `run.bat` 也会启动同一服务。

CLI 保留：

```bash
node src/main.js
```

正式检测不要带 `--limit`；`--limit` 只用于小批量验证。
```
```

- [ ] **Step 4: 更新 run-bat 操作文档**

在 `docs/run-bat-操作文档.md` 增加 Web UI 启动段落，说明 `run.bat` 从直接 CLI 检测调整为启动本地工作台。

- [ ] **Step 5: UTF-8 无 BOM 检查**

Run:

```powershell
$files = @(
  "AGENTS.md",
  "methods\node_detail_api\README.md",
  "methods\node_detail_api\docs\run-bat-操作文档.md",
  "methods\node_detail_api\docs\ui-service-实现计划.md",
  "methods\node_detail_api\docs\子智能体处理记录.md"
)
foreach ($file in $files) {
  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $file))
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw "$file 存在 BOM"
  }
}
"UTF-8 BOM 检查通过"
```

Expected: 输出 `UTF-8 BOM 检查通过`。

- [ ] **Step 6: 规格审查点**

确认文档明确“不修改旧 Python 方案”“不运行真实网络检测”“正式检测不要带 `--limit`”。

- [ ] **Step 7: 代码质量审查点**

确认文档未包含 Cookie 示例明文；确认命令使用 PowerShell/Windows 兼容写法。

- [ ] **Step 8: 记录修改文件和验证命令**

追加处理记录，记录文档检索和 BOM 检查结果。

### Task 10: 最终验收与打回门禁

**Files:**
- Read: `methods/node_detail_api/package.json`
- Read: `methods/node_detail_api/run.bat`
- Read: `methods/node_detail_api/src/*.js`
- Read: `methods/node_detail_api/test/*.test.js`
- Read: `methods/node_detail_api/web/*`
- Append: `methods/node_detail_api/docs/子智能体处理记录.md`

- [ ] **Step 1: 规格审查**

主智能体调度规格审查子智能体，逐条检查：

```text
1. run.bat 是否启动 http://localhost:3000。
2. npm start 是否启动 Web UI，node src/main.js 是否保留 CLI。
3. API 快筛默认并发是否为 5。
4. Playwright 兜底默认并发是否为 2。
5. 待确认、API 异常、风控疑似是否进入兜底。
6. 风控、登录、验证码是否输出待确认而不是失效。
7. Excel 导出是否只追加既有中文结果列。
8. UI 首屏是否为工作台。
9. 源码是否未使用 networkidle。
10. 是否未修改旧 Python 方案。
```

Expected: 审查结论为通过；如果有任一失败，打回对应任务子智能体修复。

- [ ] **Step 2: 代码质量审查**

主智能体调度代码质量审查子智能体，重点检查：

```text
1. Cookie 明文是否可能进入 UI、日志、错误、测试输出。
2. 队列停止是否会继续启动新请求。
3. Playwright 浏览器、上下文、页面是否最终关闭。
4. Web 服务接口是否只绑定本地地址。
5. 任务结果是否按 rowNumber 合并且不重复计数。
6. 文件上传路径是否限制在 uploads/。
7. 输出路径是否限制在 output/。
8. 测试是否默认只使用 mock 和本地服务。
```

Expected: 审查结论为通过；如有安全、并发、数据丢失风险，打回对应任务子智能体修复。

- [ ] **Step 3: 运行非真实网络测试**

Run: `cmd /c npm run check`

Expected: PASS，所有 `src`、`web` 相关脚本和 `test/*.test.js` 语法检查通过。

Run: `cmd /c npm test`

Expected: PASS，全部 `node:test` 测试通过。

Run: `rg "networkidle" methods\node_detail_api -g "!node_modules/**"`

Expected: 只命中文档禁用说明，源码未命中。

- [ ] **Step 4: 本地 UI 冒烟验收**

Run: `cmd /c npm start`

Expected: 控制台输出 `本地 Web UI 服务已启动：http://localhost:3000`。

在浏览器访问 `http://localhost:3000`。

Expected: 首屏显示“抖音链接检测工作台”，包含 Excel 选择、API 快筛并发、Playwright 兜底并发、开始检测、停止任务、统计、任务日志、结果预览。

- [ ] **Step 5: 本地 mock 任务验收**

使用测试或 mock 服务创建一份本地 Excel，不访问真实抖音，验证：

```text
1. 上传 Excel 后任务状态从 等待中 到 检测中 再到 已完成。
2. API mock 明确存活和失效时不进入兜底。
3. API mock 待确认时进入兜底。
4. 停止任务后未开始的行标记为 跳过，备注为 任务停止未检测。
5. 导出 Excel 包含 状态、最终链接、备注、检测时间、检测依据。
```

Expected: 5 项全部通过。

- [ ] **Step 6: 处理记录**

在 `docs/子智能体处理记录.md` 追加最终验收记录，包含：

```markdown
### 修改文件

- 列出本轮实际修改文件

### 验证命令

| 命令 | 结果 |
|------|------|
| `cmd /c npm run check` | 通过 |
| `cmd /c npm test` | 通过 |
| `rg "networkidle" methods\node_detail_api -g "!node_modules/**"` | 源码未命中 |

### 未执行项

- 未运行真实抖音网络检测。
- 未执行 git commit。
```

- [ ] **Step 7: 最终状态判断**

如果规格审查、代码质量审查、语法检查、单元测试和本地 UI 冒烟全部通过，回复 `DONE`。如果只有真实网络检测未执行，回复 `DONE_WITH_CONCERNS` 并明确“未执行真实抖音网络检测”。如果端口、依赖或测试阻断无法解决，回复 `BLOCKED` 并列出阻断条件。

## 自检结论

- 需求覆盖：本计划覆盖配置基础、HTTP API 快筛、Cookie 管理、任务队列、Web 服务、前端工作台、Excel 导出、Playwright 兜底、文档流程和最终验收。
- 协作流程：任务 10 明确主智能体调度、子智能体开发、规格审查、代码质量审查和打回门禁。
- 测试策略：每个实现任务先写失败测试，再实现最小功能，再运行指定测试；默认不运行真实抖音网络检测。
- 风险控制：Cookie 明文保护、`networkidle` 禁用、旧 Python 方案不修改、CLI 保留、端口 3000 不静默切换都已写入审查点。
- Git 策略：当前目录 git 状态异常，本计划不要求 commit，只要求记录修改文件和验证命令。
