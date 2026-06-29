import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const REQUIRED_IDS = [
  "serviceStatus",
  "cookieStatus",
  "taskStatus",
  "exportLink",
  "fileInput",
  "apiConcurrency",
  "apiSeedUrl",
  "fallbackConcurrency",
  "timeoutMs",
  "delayMs",
  "enableFallback",
  "refreshCookieButton",
  "startButton",
  "stopButton",
  "statsGrid",
  "resultsBody",
  "logList"
];

test("工作台 HTML 包含任务控制、状态、统计、表格和日志结构", async () => {
  const html = await fs.readFile("web/index.html", "utf8");

  assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(html, /抖音链接检测工作台/);
  assert.match(html, /选择 Excel/);
  assert.match(html, /API 快筛并发/);
  assert.match(html, /Playwright 兜底并发/);
  assert.match(html, /启用 Playwright 兜底/);
  assert.match(html, /刷新 Cookie/);
  assert.match(html, /结果预览/);
  assert.match(html, /任务日志/);

  for (const id of REQUIRED_IDS) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id}`);
  }
});

test("工作台提供参数种子链接输入框并使用指定默认值", async () => {
  const html = await fs.readFile("web/index.html", "utf8");

  assert.match(html, /for="apiSeedUrl">参数种子链接/);
  assert.match(html, /id="apiSeedUrl"[^>]+value="https:\/\/www\.douyin\.com\/video\/7607987902190013723"/);
});

test("前端提交任务参数时包含参数种子链接", async () => {
  const script = await fs.readFile("web/app.js", "utf8");

  assert.match(script, /apiSeedUrl:\s*document\.getElementById\("apiSeedUrl"\)/);
  assert.match(script, /apiSeedUrl:\s*readString\(elements\.apiSeedUrl\)/);
});

test("工作台参数默认值符合两阶段检测设计", async () => {
  const html = await fs.readFile("web/index.html", "utf8");

  assert.match(html, /id="apiConcurrency"[^>]+value="5"/);
  assert.match(html, /id="fallbackConcurrency"[^>]+value="2"/);
  assert.match(html, /id="timeoutMs"[^>]+value="15000"/);
  assert.match(html, /id="delayMs"[^>]+value="1000"/);
  assert.match(html, /id="enableFallback"[^>]+checked/);
});

test("前端脚本导出可测试纯函数", async () => {
  const module = await import("../web/app.js");

  assert.equal(module.formatTaskStatus({ status: "检测中" }), "检测中");
  assert.equal(module.formatTaskStatus(null), "未创建任务");
  assert.equal(module.buildQuery({ page: 2, pageSize: 50 }), "page=2&pageSize=50");
  assert.deepEqual(module.createInitialState(), {
    taskId: "",
    polling: null,
    page: 1,
    pageSize: 50
  });
  assert.equal(typeof module.fetchJson, "function");
});

test("fetchJson 遇到非 JSON 错误响应时抛出稳定中文错误", async () => {
  const { fetchJson } = await import("../web/app.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html>服务错误</html>", {
    status: 500,
    headers: { "content-type": "text/html" }
  });

  try {
    await assert.rejects(
      () => fetchJson("/api/tasks"),
      /请求失败，请查看服务日志。/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchJson 展示服务端错误前会清理敏感信息", async () => {
  const { fetchJson } = await import("../web/app.js");
  const originalFetch = globalThis.fetch;
  const unsafeError = [
    "Cookie 读取失败：sessionid=abcdef; ttwid=xyz",
    "D:\\hongye\\douyin_url\\methods\\node_detail_api\\.local\\cookies.json",
    "Error: fail",
    "    at readFile (D:\\hongye\\douyin_url\\methods\\node_detail_api\\.local\\cookies.json:1:1)"
  ].join("\n");
  globalThis.fetch = async () => new Response(JSON.stringify({ error: unsafeError }), {
    status: 500,
    headers: { "content-type": "application/json" }
  });

  try {
    await assert.rejects(
      () => fetchJson("/api/cookie/status"),
      (error) => {
        assert.match(error.message, /Cookie 读取失败/);
        assert.equal(error.message.includes("abcdef"), false);
        assert.equal(error.message.includes("xyz"), false);
        assert.equal(error.message.includes("D:\\hongye"), false);
        assert.equal(error.message.includes("readFile"), false);
        assert.equal(error.message.includes(" at "), false);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("停止请求失败且任务仍在运行时停止按钮恢复可点击", async () => {
  const { recoverStopButtonAfterFailure } = await import("../web/app.js");
  const stopButton = { disabled: true };
  const elements = { stopButton };

  recoverStopButtonAfterFailure({ currentTask: { status: "检测中" } }, elements);

  assert.equal(stopButton.disabled, false);
});

test("静态页面不是 landing page 或 hero 页面", async () => {
  const html = await fs.readFile("web/index.html", "utf8");
  const css = await fs.readFile("web/styles.css", "utf8").catch(() => "");
  const text = `${html}\n${css}`;

  assert.equal(/hero|立即体验|产品介绍|营销|装饰插画/i.test(text), false);
});

test("样式约束长链接表格并保持桌面布局不挤压", async () => {
  const css = await fs.readFile("web/styles.css", "utf8");

  assert.match(css, /\.workspace\s*{[\s\S]*grid-template-columns:\s*280px minmax\(0,\s*1fr\) 320px;/);
  assert.match(css, /\.stats-grid\s*{[\s\S]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(96px,\s*1fr\)\);/);
  assert.doesNotMatch(css, /repeat\(9,\s*minmax\(84px,\s*1fr\)\)/);
  assert.match(css, /\.table-wrap\s*{[\s\S]*overflow:\s*auto;/);
  assert.match(css, /text-overflow:\s*ellipsis;/);
  assert.match(css, /white-space:\s*nowrap;/);
});

test("前端创建任务时不固定提交空 rows", async () => {
  const script = await fs.readFile("web/app.js", "utf8");

  assert.doesNotMatch(script, /rows:\s*\[\]/);
  assert.doesNotMatch(script, /暂未接入浏览器端 Excel 解析/);
  assert.match(script, /new FormData\(\)/);
  assert.match(script, /formData\.append\("file"/);
});
