import test from "node:test";
import assert from "node:assert/strict";
import { createApiDetector } from "../src/api-detector.js";
import { extractApiProfileFromUrl } from "../src/api-profile-cache.js";
import { classifyDetailResult } from "../src/classifier.js";
import { createFallbackDetector } from "../src/detector.js";
import { createTwoStageQueue } from "../src/queue.js";
import { createDefaultWebDeps } from "../src/start-web.js";
import { createTaskManager } from "../src/task-manager.js";

function buildClassifiedResult(row, evidence) {
  const classified = classifyDetailResult(evidence);
  return {
    rowNumber: row.rowNumber,
    status: classified.status,
    contentType: classified.contentType,
    finalUrl: evidence.finalUrl || row.url,
    remark: classified.reason,
    basis: classified.basis,
    stage: evidence.stage || "fallback",
    needsFallback: evidence.needsFallback
  };
}

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
      errorType: "request_error",
      error: "HTTP 请求超时"
    }),
    fallbackDetect: async (row) => {
      const evidence = {
        stage: "fallback",
        originalUrl: row.url,
        finalUrl: row.url,
        fallbackText: "你要观看的视频不存在"
      };
      return buildClassifiedResult(row, evidence);
    }
  });

  const results = await queue.run([{ rowNumber: 2, url: "https://www.douyin.com/video/404" }]);

  assert.equal(results[0].status, "失效");
  assert.equal(results[0].basis, "dom_text");
  assert.equal(results[0].stage, "fallback");
});

test("明确存活和明确失效的 API 结果不重复进入兜底", async () => {
  const fallbackRows = [];
  const apiResults = new Map([
    [2, { status: "存活", basis: "detail_api", needsFallback: false }],
    [3, { status: "失效", basis: "detail_api", needsFallback: false }]
  ]);
  const queue = createTwoStageQueue({
    apiConcurrency: 1,
    fallbackConcurrency: 1,
    apiDetect: async (row) => ({
      rowNumber: row.rowNumber,
      ...apiResults.get(row.rowNumber)
    }),
    fallbackDetect: async (row) => {
      fallbackRows.push(row);
      return {
        rowNumber: row.rowNumber,
        status: "待确认",
        basis: "dom_text",
        stage: "fallback"
      };
    }
  });

  const results = await queue.run([
    { rowNumber: 2, url: "https://www.douyin.com/video/1" },
    { rowNumber: 3, url: "https://www.douyin.com/video/2" }
  ]);

  assert.deepEqual(results.map((result) => result.status), ["存活", "失效"]);
  assert.equal(fallbackRows.length, 0);
});

test("兜底遇到登录验证码或访问频繁时保持待确认", async () => {
  const queue = createTwoStageQueue({
    apiConcurrency: 1,
    fallbackConcurrency: 1,
    apiDetect: async (row) => ({
      rowNumber: row.rowNumber,
      status: "待确认",
      basis: "detail_api",
      needsFallback: true,
      riskSuspected: true
    }),
    fallbackDetect: async (row) => {
      const evidence = {
        stage: "fallback",
        originalUrl: row.url,
        finalUrl: row.url,
        fallbackText: "请先登录并完成验证码，访问过于频繁，请稍后再试"
      };
      return buildClassifiedResult(row, evidence);
    }
  });

  const results = await queue.run([{ rowNumber: 2, url: "https://www.douyin.com/video/risk" }]);

  assert.equal(results[0].status, "待确认");
  assert.equal(results[0].basis, "heuristic");
  assert.equal(results[0].stage, "fallback");
});

test("createFallbackDetector 复用 detail detector 并统一支持 row 和字符串输入", async () => {
  const calls = [];
  let closed = false;
  const detailDetector = {
    async detect(url) {
      calls.push(url);
      return {
        originalUrl: url,
        finalUrl: `${url}?from=fallback`,
        fallbackText: "点赞 评论"
      };
    },
    async close() {
      closed = true;
    }
  };

  const detector = createFallbackDetector({ detailDetector });
  const rowResult = await detector.detect({ rowNumber: 2, url: "https://www.douyin.com/video/123" });
  const stringResult = await detector.detect("https://www.douyin.com/note/456");
  await detector.close();

  assert.deepEqual(calls, [
    "https://www.douyin.com/video/123",
    "https://www.douyin.com/note/456"
  ]);
  assert.equal(rowResult.rowNumber, 2);
  assert.equal(rowResult.stage, "fallback");
  assert.equal(rowResult.needsFallback, false);
  assert.equal(stringResult.stage, "fallback");
  assert.equal(closed, true);
});

test("task-manager 使用注入的 API 和兜底 detector 组装两阶段队列", async () => {
  const manager = createTaskManager({
    apiDetector: {
      async detect(url) {
        return {
          stage: "api",
          originalUrl: url,
          finalUrl: url,
          detailJson: null,
          needsFallback: true,
          errorType: "request_error",
          error: "detail API 请求超时"
        };
      }
    },
    fallbackDetector: {
      async detect(row) {
        return {
          stage: "fallback",
          originalUrl: row.url,
          finalUrl: row.url,
          fallbackText: "你要观看的视频不存在",
          needsFallback: false
        };
      }
    },
    classifyDetailResult
  });
  const task = await manager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/404" }],
    options: { apiConcurrency: 1, fallbackConcurrency: 1 }
  });

  await manager.startTask(task.id);
  const page = manager.getTaskResults(task.id, { page: 1, pageSize: 1 });
  const snapshot = manager.getTask(task.id);

  assert.equal(page.results[0].status, "失效");
  assert.equal(page.results[0].basis, "dom_text");
  assert.equal(page.results[0].stage, "fallback");
  assert.equal(snapshot.stats.fallbackChecked, 1);
});

test("默认 Web 依赖组装真实两阶段 detector 而不是空跑队列", async () => {
  const seen = {
    cookieHeader: "",
    apiCalls: 0,
    fallbackClosed: false
  };
  const deps = createDefaultWebDeps({
    apiProfileCache: false,
    cookieStore: {
      async getCookieHeader() {
        return "sessionid=secret";
      }
    },
    createApiDetector: (options) => ({
      async detect(url) {
        seen.apiCalls += 1;
        seen.cookieHeader = options.cookieHeader;
        return {
          stage: "api",
          originalUrl: url,
          finalUrl: url,
          detailJson: null,
          fallbackText: "点赞 评论",
          needsFallback: false
        };
      }
    }),
    createFallbackDetector: () => ({
      async detect(row) {
        return {
          stage: "fallback",
          originalUrl: row.url,
          finalUrl: row.url,
          fallbackText: "你要观看的视频不存在",
          needsFallback: false
        };
      },
      async close() {
        seen.fallbackClosed = true;
      }
    })
  });

  const task = await deps.taskManager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/123" }],
    options: { apiConcurrency: 1, fallbackConcurrency: 1 }
  });
  await deps.taskManager.startTask(task.id);
  const page = deps.taskManager.getTaskResults(task.id, { page: 1, pageSize: 1 });
  await deps.close();

  assert.equal(seen.apiCalls, 1);
  assert.equal(seen.cookieHeader, "sessionid=secret");
  assert.equal(page.results[0].status, "存活");
  assert.equal(page.results[0].stage, "api");
  assert.equal(seen.fallbackClosed, true);
});

test("默认 Web API 快筛缺 Cookie 时先自动刷新再请求 detail API", async () => {
  let cookieHeader = "";
  let refreshCalls = 0;
  const seen = { cookieHeaders: [] };
  const deps = createDefaultWebDeps({
    apiProfileCache: false,
    cookieStore: {
      async getCookieHeader() {
        return cookieHeader;
      },
      async saveCookieHeader(value) {
        cookieHeader = value;
      }
    },
    cookieRefresher: {
      async refresh() {
        refreshCalls += 1;
        cookieHeader = "ttwid=visitor-cookie";
        return { exists: true, summary: "1 个 Cookie", refreshedAt: "2026-06-24T10:00:00.000Z" };
      }
    },
    createApiDetector: (options) => ({
      async detect(url) {
        seen.cookieHeaders.push(options.cookieHeader);
        return {
          stage: "api",
          originalUrl: url,
          finalUrl: url,
          detailJson: {
            aweme_detail: {
              aweme_id: "123",
              desc: "测试视频",
              video: { play_addr: { url_list: ["https://example.test/v.mp4"] } },
              statistics: { digg_count: 1 }
            }
          },
          needsFallback: false
        };
      }
    }),
    createFallbackDetector: () => ({
      async detect() {
        assert.fail("Cookie 刷新成功后不应进入 Playwright 兜底");
      },
      async close() {}
    })
  });

  const task = await deps.taskManager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/123" }],
    options: { apiConcurrency: 1, fallbackConcurrency: 1 }
  });
  await deps.taskManager.startTask(task.id);
  const page = deps.taskManager.getTaskResults(task.id, { page: 1, pageSize: 1 });
  await deps.close();

  assert.equal(refreshCalls, 1);
  assert.deepEqual(seen.cookieHeaders, ["ttwid=visitor-cookie"]);
  assert.equal(page.results[0].status, "存活");
  assert.equal(page.results[0].stage, "api");
});

test("默认 Web API 快筛初始缺 Cookie 且首次 API 风控时再次刷新并重试成功", async () => {
  let cookieHeader = "";
  let refreshCalls = 0;
  const seen = { cookieHeaders: [] };
  const deps = createDefaultWebDeps({
    apiProfileCache: false,
    cookieStore: {
      async getCookieHeader() {
        return cookieHeader;
      }
    },
    cookieRefresher: {
      async refresh() {
        refreshCalls += 1;
        cookieHeader = refreshCalls === 1 ? "ttwid=visitor-old" : "ttwid=visitor-new";
        return { exists: true, summary: "1 个 Cookie", refreshedAt: "2026-06-24T10:00:00.000Z" };
      }
    },
    createApiDetector: (options) => ({
      async detect(url) {
        seen.cookieHeaders.push(options.cookieHeader);
        if (seen.cookieHeaders.length === 1) {
          return {
            stage: "api",
            originalUrl: url,
            finalUrl: url,
            detailJson: { status_code: 2149, status_msg: "请先登录后继续访问" },
            needsFallback: true,
            errorType: "risk_control",
            error: "detail API 返回登录或验证码提示"
          };
        }
        return {
          stage: "api",
          originalUrl: url,
          finalUrl: url,
          detailJson: {
            aweme_detail: {
              aweme_id: "123",
              desc: "第二次刷新后成功",
              video: { play_addr: { url_list: ["https://example.test/v.mp4"] } },
              statistics: { digg_count: 1 }
            }
          },
          needsFallback: false
        };
      }
    }),
    createFallbackDetector: () => ({
      async detect() {
        assert.fail("初始缺 Cookie 后的风控重试成功时不应进入 Playwright 兜底");
      },
      async close() {}
    })
  });

  const task = await deps.taskManager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/123" }],
    options: { apiConcurrency: 1, fallbackConcurrency: 1 }
  });
  await deps.taskManager.startTask(task.id);
  const page = deps.taskManager.getTaskResults(task.id, { page: 1, pageSize: 1 });
  await deps.close();

  assert.equal(refreshCalls, 2);
  assert.deepEqual(seen.cookieHeaders, ["ttwid=visitor-old", "ttwid=visitor-new"]);
  assert.equal(page.results[0].status, "存活");
  assert.equal(page.results[0].stage, "api");
});

test("默认 Web API 快筛初始缺 Cookie 且刷新重试仍风控时转兜底且不无限重试", async () => {
  let cookieHeader = "";
  let refreshCalls = 0;
  const seen = { cookieHeaders: [] };
  const fallbackApiErrors = [];
  const deps = createDefaultWebDeps({
    apiProfileCache: false,
    cookieStore: {
      async getCookieHeader() {
        return cookieHeader;
      }
    },
    cookieRefresher: {
      async refresh() {
        refreshCalls += 1;
        cookieHeader = `ttwid=visitor-${refreshCalls}`;
        return { exists: true, summary: "1 个 Cookie", refreshedAt: "2026-06-24T10:00:00.000Z" };
      }
    },
    createApiDetector: (options) => ({
      async detect(url) {
        seen.cookieHeaders.push(options.cookieHeader);
        return {
          stage: "api",
          originalUrl: url,
          finalUrl: url,
          detailJson: { status_code: 2149, status_msg: "请先登录" },
          needsFallback: true,
          errorType: "risk_control",
          error: "detail API 返回登录或验证码提示"
        };
      }
    }),
    createFallbackDetector: () => ({
      async detect(row) {
        fallbackApiErrors.push(row.apiResult?.error || "");
        return {
          stage: "fallback",
          originalUrl: row.url,
          finalUrl: row.url,
          fallbackText: "你要观看的视频不存在",
          needsFallback: false
        };
      },
      async close() {}
    })
  });

  const task = await deps.taskManager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/404" }],
    options: { apiConcurrency: 1, fallbackConcurrency: 1 }
  });
  await deps.taskManager.startTask(task.id);
  const page = deps.taskManager.getTaskResults(task.id, { page: 1, pageSize: 1 });
  await deps.close();

  assert.equal(refreshCalls, 2);
  assert.deepEqual(seen.cookieHeaders, ["ttwid=visitor-1", "ttwid=visitor-2"]);
  assert.equal(fallbackApiErrors.length, 1);
  assert.equal(page.results[0].status, "失效");
  assert.equal(page.results[0].stage, "fallback");
});

test("默认 Web API 快筛疑似 Cookie 失效时最多刷新重试一次", async () => {
  let cookieHeader = "ttwid=old-cookie";
  let refreshCalls = 0;
  const seen = { cookieHeaders: [] };
  const deps = createDefaultWebDeps({
    apiProfileCache: false,
    cookieStore: {
      async getCookieHeader() {
        return cookieHeader;
      }
    },
    cookieRefresher: {
      async refresh() {
        refreshCalls += 1;
        cookieHeader = "ttwid=new-cookie";
        return { exists: true, summary: "1 个 Cookie", refreshedAt: "2026-06-24T10:00:00.000Z" };
      }
    },
    createApiDetector: (options) => ({
      async detect(url) {
        seen.cookieHeaders.push(options.cookieHeader);
        if (seen.cookieHeaders.length === 1) {
          return {
            stage: "api",
            originalUrl: url,
            finalUrl: url,
            detailJson: { status_code: 2149, status_msg: "请先登录" },
            needsFallback: true,
            errorType: "risk_control",
            error: "detail API 返回登录或验证提示"
          };
        }
        return {
          stage: "api",
          originalUrl: url,
          finalUrl: url,
          detailJson: {
            aweme_detail: {
              aweme_id: "123",
              desc: "刷新后成功",
              video: { play_addr: { url_list: ["https://example.test/v.mp4"] } },
              statistics: { digg_count: 1 }
            }
          },
          needsFallback: false
        };
      }
    }),
    createFallbackDetector: () => ({
      async detect() {
        assert.fail("刷新重试成功后不应进入 Playwright 兜底");
      },
      async close() {}
    })
  });

  const task = await deps.taskManager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/123" }],
    options: { apiConcurrency: 1, fallbackConcurrency: 1 }
  });
  await deps.taskManager.startTask(task.id);
  const page = deps.taskManager.getTaskResults(task.id, { page: 1, pageSize: 1 });
  await deps.close();

  assert.equal(refreshCalls, 1);
  assert.deepEqual(seen.cookieHeaders, ["ttwid=old-cookie", "ttwid=new-cookie"]);
  assert.equal(page.results[0].status, "存活");
  assert.equal(page.results[0].stage, "api");
});

test("默认 Web API 快筛刷新失败时脱敏错误并转入 Playwright 兜底", async () => {
  const fallbackApiErrors = [];
  const deps = createDefaultWebDeps({
    apiProfileCache: false,
    cookieStore: {
      async getCookieHeader() {
        return "";
      }
    },
    cookieRefresher: {
      async refresh() {
        throw new Error("游客 Cookie 刷新失败：sessionid=secret-cookie; ttwid=secret-ttwid");
      }
    },
    createApiDetector: () => ({
      async detect() {
        assert.fail("缺 Cookie 且刷新失败时不应继续请求 detail API");
      }
    }),
    createFallbackDetector: () => ({
      async detect(row) {
        fallbackApiErrors.push(row.apiResult?.error || "");
        return {
          stage: "fallback",
          originalUrl: row.url,
          finalUrl: row.url,
          fallbackText: "你要观看的视频不存在",
          needsFallback: false
        };
      },
      async close() {}
    })
  });

  const task = await deps.taskManager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/404" }],
    options: { apiConcurrency: 1, fallbackConcurrency: 1 }
  });
  await deps.taskManager.startTask(task.id);
  const page = deps.taskManager.getTaskResults(task.id, { page: 1, pageSize: 1 });
  await deps.close();

  assert.equal(fallbackApiErrors.length, 1);
  assert.match(fallbackApiErrors[0], /Cookie 刷新失败/);
  assert.doesNotMatch(fallbackApiErrors[0], /secret-cookie/);
  assert.doesNotMatch(fallbackApiErrors[0], /secret-ttwid/);
  assert.match(fallbackApiErrors[0], /sessionid=\*\*\*/);
  assert.match(fallbackApiErrors[0], /ttwid=\*\*\*/);
  assert.equal(page.results[0].status, "失效");
  assert.equal(page.results[0].stage, "fallback");
});

test("默认 Web 任务启动时使用参数种子链接预热参数画像并传给 API 快筛", async () => {
  const seen = {
    prewarmUrls: [],
    apiProfileStatuses: []
  };
  const seedUrl = "https://www.douyin.com/video/7607987902190013723";
  const deps = createDefaultWebDeps({
    cookieStore: {
      async getCookieHeader() {
        return "ttwid=visitor-cookie";
      }
    },
    apiProfileCache: {
      async ensureProfile(url) {
        seen.prewarmUrls.push(url);
        return { ok: true, status: "ready" };
      },
      getProfile() {
        return { status: "ready", endpoint: "https://www.douyin.com/aweme/v1/web/aweme/detail/", queryParams: [["aweme_id", "123"]] };
      },
      getStatus() {
        return { status: "ready" };
      }
    },
    createApiDetector: (options) => ({
      async detect(url) {
        seen.apiProfileStatuses.push(options.apiProfile?.status || options.apiProfileCache?.getStatus?.().status || "");
        return {
          stage: "api",
          originalUrl: url,
          finalUrl: url,
          detailJson: {
            aweme_detail: {
              aweme_id: "123",
              desc: "画像预热后成功",
              video: { play_addr: { url_list: ["https://example.test/v.mp4"] } },
              statistics: { digg_count: 1 }
            }
          },
          needsFallback: false,
          apiCacheUsed: true,
          apiProfileStatus: "ready"
        };
      }
    }),
    createFallbackDetector: () => ({
      async detect() {
        assert.fail("API 成功时不应进入兜底");
      },
      async close() {}
    })
  });

  const task = await deps.taskManager.createTask({
    rows: [
      { rowNumber: 2, url: "https://example.com/not-douyin" },
      { rowNumber: 3, url: "https://www.douyin.com/video/123" }
    ],
    options: { apiConcurrency: 1, fallbackConcurrency: 1, apiSeedUrl: seedUrl }
  });
  await deps.taskManager.startTask(task.id);
  const page = deps.taskManager.getTaskResults(task.id, { page: 1, pageSize: 2 });
  await deps.close();

  assert.deepEqual(seen.prewarmUrls, [seedUrl]);
  assert.equal(seen.apiProfileStatuses.includes("ready"), true);
  assert.equal(page.results.find((item) => item.rowNumber === 3).apiCacheUsed, true);
  assert.equal(page.results.find((item) => item.rowNumber === 3).apiProfileStatus, "ready");
});

test("默认 Web 任务有 seed 时等待慢预热完成后才启动队列", async () => {
  let releasePrewarm;
  let runQueueStarted = false;
  const prewarmBlocker = new Promise((resolve) => {
    releasePrewarm = resolve;
  });
  const manager = createTaskManager({
    apiProfileCache: {
      async ensureProfile() {
        await prewarmBlocker;
        return { ok: true, status: "ready" };
      }
    },
    runQueue: async ({ rows, onResult }) => {
      runQueueStarted = true;
      const result = {
        rowNumber: rows[0].rowNumber,
        status: "存活",
        finalUrl: rows[0].url,
        basis: "detail_api",
        stage: "api"
      };
      onResult(result);
      return [result];
    }
  });
  const task = await manager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/123" }],
    options: { apiSeedUrl: "https://www.douyin.com/video/7607987902190013723" }
  });

  const startPromise = manager.startTask(task.id);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(runQueueStarted, false);
  releasePrewarm();
  await startPromise;
  assert.equal(runQueueStarted, true);
});

test("默认 Web 任务参数画像预热失败不阻塞旧候选和兜底且日志脱敏", async () => {
  const fallbackApiErrors = [];
  const deps = createDefaultWebDeps({
    cookieStore: {
      async getCookieHeader() {
        return "ttwid=visitor-cookie";
      }
    },
    apiProfileCache: {
      async ensureProfile() {
        return {
          ok: false,
          status: "failed",
          error: "预热失败：sessionid=*** storagePath=*** a_bogus=***"
        };
      },
      getProfile() {
        return null;
      },
      getStatus() {
        return { status: "failed", error: "预热失败：sessionid=*** storagePath=*** a_bogus=***" };
      }
    },
    createApiDetector: () => ({
      async detect(url) {
        return {
          stage: "api",
          originalUrl: url,
          finalUrl: url,
          detailJson: null,
          needsFallback: true,
          errorType: "http_status",
          error: "旧 HTTP 候选失败：HTTP 状态码 404。",
          apiCacheUsed: false,
          apiProfileStatus: "failed"
        };
      }
    }),
    createFallbackDetector: () => ({
      async detect(row) {
        fallbackApiErrors.push(row.apiResult?.error || "");
        return {
          stage: "fallback",
          originalUrl: row.url,
          finalUrl: row.url,
          fallbackText: "你要观看的视频不存在",
          needsFallback: false
        };
      },
      async close() {}
    })
  });

  const task = await deps.taskManager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/404" }],
    options: {
      apiConcurrency: 1,
      fallbackConcurrency: 1,
      apiSeedUrl: "https://www.douyin.com/video/7607987902190013723"
    }
  });
  await deps.taskManager.startTask(task.id);
  const snapshot = deps.taskManager.getTask(task.id);
  const page = deps.taskManager.getTaskResults(task.id, { page: 1, pageSize: 1 });
  const snapshotText = JSON.stringify(snapshot);
  await deps.close();

  assert.equal(fallbackApiErrors.length, 1);
  assert.equal(page.results[0].status, "失效");
  assert.equal(page.results[0].stage, "fallback");
  assert.equal(page.results[0].apiCacheUsed, false);
  assert.equal(page.results[0].apiProfileStatus, "failed");
  assert.match(snapshotText, /参数种子链接预热失败/);
  assert.doesNotMatch(snapshotText, /secret|Users|a_bogus=[^*]/);
});

test("全部 API 候选失败进入兜底后最终结果保留候选来源", async () => {
  const profile = extractApiProfileFromUrl(
    "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=111&webid=web-1",
    { capturedAt: 1000, ttlMs: 600000, sourceWorkId: "111" }
  );
  const manager = createTaskManager({
    apiDetector: createApiDetector({
      apiProfile: profile,
      fetchImpl: async () => new Response("not found", { status: 404 })
    }),
    fallbackDetector: {
      async detect(row) {
        return {
          stage: "fallback",
          originalUrl: row.url,
          finalUrl: row.url,
          fallbackText: "你要观看的视频不存在",
          needsFallback: false
        };
      },
      async close() {}
    },
    classifyDetailResult
  });
  const task = await manager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/222" }],
    options: { apiConcurrency: 1, fallbackConcurrency: 1 }
  });

  await manager.startTask(task.id);
  const page = manager.getTaskResults(task.id, { page: 1, pageSize: 1 });

  assert.equal(page.results[0].stage, "fallback");
  assert.equal(page.results[0].apiCandidateSource, "default");
  assert.deepEqual(page.results[0].apiCandidateSources, ["profile", "default"]);
});
