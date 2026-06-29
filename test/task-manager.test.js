import test from "node:test";
import assert from "node:assert/strict";
import { createTaskManager } from "../src/task-manager.js";

test("任务启动时只使用参数种子链接预热 API 参数画像", async () => {
  const prewarmUrls = [];
  const manager = createTaskManager({
    apiProfileCache: {
      async ensureProfile(url) {
        prewarmUrls.push(url);
        return { ok: true, status: "ready" };
      }
    },
    runQueue: async () => []
  });
  const seedUrl = "https://www.douyin.com/video/7607987902190013723";
  const task = await manager.createTask({
    rows: [
      { rowNumber: 2, url: "https://www.douyin.com/video/111" },
      { rowNumber: 3, url: "https://www.douyin.com/note/222" }
    ],
    options: { apiSeedUrl: seedUrl }
  });

  await manager.startTask(task.id);

  assert.deepEqual(prewarmUrls, [seedUrl]);
});

test("参数种子链接为空时不预热，也不回退到 Excel 第一条链接", async () => {
  const prewarmUrls = [];
  const manager = createTaskManager({
    apiProfileCache: {
      async ensureProfile(url) {
        prewarmUrls.push(url);
        return { ok: true, status: "ready" };
      }
    },
    runQueue: async () => []
  });
  const task = await manager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/111" }],
    options: { apiSeedUrl: "" }
  });

  await manager.startTask(task.id);

  assert.deepEqual(prewarmUrls, []);
});

test("参数种子链接不是支持的抖音作品链接时不预热", async () => {
  const prewarmUrls = [];
  const manager = createTaskManager({
    apiProfileCache: {
      async ensureProfile(url) {
        prewarmUrls.push(url);
        return { ok: true, status: "ready" };
      }
    },
    runQueue: async () => []
  });
  const task = await manager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/111" }],
    options: { apiSeedUrl: "https://www.douyin.com/user/example" }
  });

  await manager.startTask(task.id);

  assert.deepEqual(prewarmUrls, []);
});

test("参数种子链接预热失败不阻塞任务并记录降级日志", async () => {
  let runQueueStarted = false;
  const manager = createTaskManager({
    apiProfileCache: {
      async ensureProfile() {
        return { ok: false, status: "failed", error: "sessionid=secret; D:\\tmp\\cookies.json" };
      }
    },
    runQueue: async ({ rows, onResult }) => {
      runQueueStarted = true;
      const result = {
        rowNumber: rows[0].rowNumber,
        status: "存活",
        basis: "detail_api",
        stage: "api"
      };
      onResult(result);
      return [result];
    }
  });
  const task = await manager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/111" }],
    options: { apiSeedUrl: "https://www.douyin.com/video/7607987902190013723" }
  });

  await manager.startTask(task.id);
  const snapshotText = JSON.stringify(manager.getTask(task.id));

  assert.equal(runQueueStarted, true);
  assert.match(snapshotText, /参数种子链接预热失败/);
  assert.match(snapshotText, /继续使用旧 HTTP 候选和 Playwright 兜底/);
  assert.doesNotMatch(snapshotText, /secret|D:\\tmp/);
});

test("任务快照 options 暴露非敏感的参数种子链接", async () => {
  const seedUrl = "https://www.douyin.com/video/7607987902190013723";
  const manager = createTaskManager({ runQueue: async () => [] });
  const task = await manager.createTask({
    rows: [],
    options: { apiSeedUrl: seedUrl, cookieHeader: "sessionid=secret" }
  });

  const snapshot = manager.getTask(task.id);
  const snapshotText = JSON.stringify(snapshot);

  assert.equal(snapshot.options.apiSeedUrl, seedUrl);
  assert.equal(snapshotText.includes("secret"), false);
});

test("任务结果分页和导出 payload 不泄露 profile API URL 敏感参数值", async () => {
  const fullApiUrl = "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=222&a_bogus=secret-a&msToken=secret-ms&x-secsdk-web-signature=secret-sign&timestamp=123456&webid=web-1";
  const manager = createTaskManager({
    runQueue: async ({ rows, onResult }) => {
      const result = {
        rowNumber: rows[0].rowNumber,
        status: "存活",
        basis: "detail_api",
        stage: "api",
        apiUrl: fullApiUrl,
        apiCandidateSource: "profile",
        apiCandidateSources: ["profile", "default"]
      };
      onResult(result);
      return [result];
    }
  });
  const task = await manager.createTask({
    inputData: { sheets: [{ name: "Sheet1" }] },
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/222" }]
  });

  await manager.startTask(task.id);
  const pageText = JSON.stringify(manager.getTaskResults(task.id, { page: 1, pageSize: 1 }));
  const exportText = JSON.stringify(manager.getTaskExportPayload(task.id));

  assert.match(pageText, /aweme_id=222/);
  assert.match(pageText, /a_bogus=\*\*\*/);
  assert.match(pageText, /msToken=\*\*\*/);
  assert.match(pageText, /x-secsdk-web-signature=\*\*\*/);
  assert.match(pageText, /timestamp=\*\*\*/);
  assert.doesNotMatch(pageText, /secret-a|secret-ms|secret-sign|123456/);
  assert.doesNotMatch(exportText, /secret-a|secret-ms|secret-sign|123456/);
});

test("createTaskManager 创建任务并维护中文状态、进度和统计", async () => {
  const manager = createTaskManager({
    runQueue: async ({ rows, onResult }) => {
      const result = {
        rowNumber: rows[0].rowNumber,
        status: "存活",
        basis: "detail_api",
        stage: "api"
      };
      onResult(result);
      return [result];
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
  assert.equal(snapshot.progress.total, 1);
  assert.equal(snapshot.progress.processed, 1);
  assert.equal(snapshot.stats.total, 1);
  assert.equal(snapshot.stats.processed, 1);
  assert.equal(snapshot.stats.alive, 1);
  assert.equal(snapshot.stats.dead, 0);
  assert.equal(snapshot.stats.pending, 0);
  assert.equal(snapshot.stats.failed, 0);
  assert.equal(snapshot.stats.skipped, 0);
  assert.equal(snapshot.stats.apiChecked, 1);
  assert.equal(snapshot.stats.fallbackChecked, 0);
  assert.equal(snapshot.logs.length > 0, true);
});

test("任务管理维护结果列表并支持分页读取", async () => {
  const manager = createTaskManager({
    runQueue: async ({ rows, onResult }) => {
      const results = rows.map((row, index) => ({
        rowNumber: row.rowNumber,
        status: index % 2 === 0 ? "存活" : "失效",
        basis: index % 2 === 0 ? "detail_api" : "dom_text",
        stage: index % 2 === 0 ? "api" : "fallback"
      }));
      for (const result of results) {
        onResult(result);
      }
      return results;
    }
  });

  const task = await manager.createTask({
    rows: [
      { rowNumber: 2, url: "https://www.douyin.com/video/1" },
      { rowNumber: 3, url: "https://www.douyin.com/video/2" },
      { rowNumber: 4, url: "https://www.douyin.com/video/3" }
    ]
  });

  await manager.startTask(task.id);
  const page = manager.getTaskResults(task.id, { page: 2, pageSize: 1 });

  assert.equal(page.total, 3);
  assert.equal(page.page, 2);
  assert.equal(page.pageSize, 1);
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].rowNumber, 3);
});

test("任务快照不包含完整 results，结果只能通过分页读取", async () => {
  const manager = createTaskManager({
    runQueue: async ({ rows, onResult }) => {
      const results = rows.map((row) => ({
        rowNumber: row.rowNumber,
        status: "存活",
        basis: "detail_api",
        stage: "api"
      }));
      for (const result of results) {
        onResult(result);
      }
      return results;
    }
  });
  const task = await manager.createTask({
    rows: Array.from({ length: 25 }, (_, index) => ({
      rowNumber: index + 2,
      url: `https://www.douyin.com/video/${index + 1}`
    }))
  });

  await manager.startTask(task.id);
  const snapshot = manager.getTask(task.id);
  const page = manager.getTaskResults(task.id, { page: 3, pageSize: 5 });

  assert.equal(Object.hasOwn(snapshot, "results"), false);
  assert.equal(page.total, 25);
  assert.equal(page.results.length, 5);
  assert.deepEqual(page.results.map((result) => result.rowNumber), [12, 13, 14, 15, 16]);
});

test("任务快照不包含 rows、inputData、results 和 activeSignal 等大对象或内部对象", async () => {
  const manager = createTaskManager({
    runQueue: async ({ rows, onResult }) => {
      const results = rows.map((row) => ({
        rowNumber: row.rowNumber,
        status: "存活",
        basis: "detail_api",
        stage: "api"
      }));
      for (const result of results) {
        onResult(result);
      }
      return results;
    }
  });
  const task = await manager.createTask({
    inputPath: "input.xlsx",
    outputPath: "output.xlsx",
    inputData: {
      workbook: { shouldNotLeak: true },
      rows: Array.from({ length: 10 }, (_, index) => ({ rowNumber: index + 2 }))
    },
    rows: Array.from({ length: 10 }, (_, index) => ({
      rowNumber: index + 2,
      url: `https://www.douyin.com/video/${index + 1}`
    }))
  });

  const startedSnapshot = await manager.startTask(task.id);
  const snapshot = manager.getTask(task.id);

  for (const key of ["rows", "inputData", "results", "activeSignal"]) {
    assert.equal(Object.hasOwn(startedSnapshot, key), false);
    assert.equal(Object.hasOwn(snapshot, key), false);
  }
  assert.equal(snapshot.id, task.id);
  assert.equal(snapshot.status, "已完成");
  assert.equal(snapshot.progress.total, 10);
  assert.equal(snapshot.stats.total, 10);
  assert.equal(snapshot.outputPath, "output.xlsx");
});

test("getTaskResults 限制最大 pageSize 并返回实际 pageSize", async () => {
  const manager = createTaskManager({
    runQueue: async ({ rows, onResult }) => {
      const results = rows.map((row) => ({
        rowNumber: row.rowNumber,
        status: "存活",
        basis: "detail_api",
        stage: "api"
      }));
      for (const result of results) {
        onResult(result);
      }
      return results;
    }
  });
  const task = await manager.createTask({
    rows: Array.from({ length: 150 }, (_, index) => ({
      rowNumber: index + 2,
      url: `https://www.douyin.com/video/${index + 1}`
    }))
  });

  await manager.startTask(task.id);
  const page = manager.getTaskResults(task.id, { page: 1, pageSize: 1000 });

  assert.equal(page.total, 150);
  assert.equal(page.pageSize, 100);
  assert.equal(page.results.length, 100);
});

test("任务快照 options 只返回非敏感白名单配置", async () => {
  const manager = createTaskManager({ runQueue: async () => [] });
  const task = await manager.createTask({
    rows: [],
    options: {
      apiConcurrency: 5,
      fallbackConcurrency: 2,
      timeoutMs: 15000,
      delayMs: 1000,
      enableFallback: true,
      cookieHeader: "sessionid=secret; ttwid=secret2",
      sessionid: "secret"
    }
  });

  const snapshot = manager.getTask(task.id);
  const snapshotText = JSON.stringify(snapshot);

  assert.deepEqual(snapshot.options, {
    apiConcurrency: 5,
    fallbackConcurrency: 2,
    timeoutMs: 15000,
    delayMs: 1000,
    enableFallback: true
  });
  assert.equal(snapshotText.includes("cookieHeader"), false);
  assert.equal(snapshotText.includes("secret"), false);
  assert.equal(snapshotText.includes("secret2"), false);
});

test("任务停止会转发 stop signal 并记录未开始行跳过统计", async () => {
  let capturedSignal;
  const manager = createTaskManager({
    runQueue: async ({ rows, signal, onResult }) => {
      capturedSignal = signal;
      assert.equal(signal.stopped, true);
      const results = rows.map((row) => ({
        rowNumber: row.rowNumber,
        status: "跳过",
        finalUrl: row.url,
        remark: "任务停止未检测",
        basis: "stopped"
      }));
      for (const result of results) {
        onResult(result);
      }
      return results;
    }
  });
  const task = await manager.createTask({
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/1" }]
  });

  manager.stopTask(task.id);
  await manager.startTask(task.id);
  const snapshot = manager.getTask(task.id);
  const page = manager.getTaskResults(task.id, { page: 1, pageSize: 1 });

  assert.equal(capturedSignal.stopped, true);
  assert.equal(snapshot.status, "已停止");
  assert.equal(snapshot.stats.skipped, 1);
  assert.equal(Object.hasOwn(snapshot, "results"), false);
  assert.equal(page.results[0].remark, "任务停止未检测");
});

test("任务日志最多保留最近 200 条且不记录 Cookie 明文", () => {
  const manager = createTaskManager({ runQueue: async () => [] });
  const task = manager.createMemoryTaskForTest({ rows: [] });

  for (let index = 0; index < 250; index += 1) {
    manager.addLog(task.id, "信息", `日志 ${index} sessionid=secret-${index}`);
  }

  const logs = manager.getTask(task.id).logs;
  assert.equal(logs.length, 200);
  assert.equal(logs.some((log) => log.message.includes("secret-249")), false);
  assert.equal(logs.at(-1).message.includes("sessionid=***"), true);
});
