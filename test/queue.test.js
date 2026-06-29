import test from "node:test";
import assert from "node:assert/strict";
import { createTwoStageQueue } from "../src/queue.js";

test("API 明确结果不进入 Playwright 兜底", async () => {
  const fallbackCalls = [];
  const queue = createTwoStageQueue({
    apiConcurrency: 2,
    fallbackConcurrency: 1,
    apiDetect: async (row) => ({
      rowNumber: row.rowNumber,
      status: "存活",
      basis: "detail_api",
      needsFallback: false
    }),
    fallbackDetect: async (row) => fallbackCalls.push(row)
  });

  const results = await queue.run([{ rowNumber: 2, url: "https://www.douyin.com/video/123" }]);

  assert.equal(results[0].status, "存活");
  assert.equal(results[0].basis, "detail_api");
  assert.equal(fallbackCalls.length, 0);
});

test("API 待确认、异常和风控疑似结果进入 Playwright 兜底", async () => {
  const fallbackRows = [];
  const apiResults = new Map([
    [2, { status: "待确认", errorType: "", needsFallback: true }],
    [3, { status: "待确认", errorType: "request_error", needsFallback: false }],
    [4, { status: "待确认", errorType: "risk_control", needsFallback: false }]
  ]);
  const queue = createTwoStageQueue({
    apiConcurrency: 1,
    fallbackConcurrency: 1,
    apiDetect: async (row) => ({
      rowNumber: row.rowNumber,
      basis: "detail_api",
      ...apiResults.get(row.rowNumber)
    }),
    fallbackDetect: async (row) => {
      fallbackRows.push(row.rowNumber);
      return {
        rowNumber: row.rowNumber,
        status: "失效",
        basis: "dom_text",
        stage: "fallback"
      };
    }
  });

  const results = await queue.run([
    { rowNumber: 2, url: "https://www.douyin.com/note/404" },
    { rowNumber: 3, url: "https://www.douyin.com/video/error" },
    { rowNumber: 4, url: "https://www.douyin.com/video/risk" }
  ]);

  assert.deepEqual(fallbackRows, [2, 3, 4]);
  assert.deepEqual(results.map((result) => result.status), ["失效", "失效", "失效"]);
  assert.deepEqual(results.map((result) => result.stage), ["fallback", "fallback", "fallback"]);
});

test("默认并发来自配置且测试可注入覆盖", async () => {
  const queue = createTwoStageQueue({
    apiDetect: async (row) => ({
      rowNumber: row.rowNumber,
      status: "存活",
      basis: "detail_api",
      needsFallback: false
    }),
    fallbackDetect: async () => assert.fail("明确存活不应兜底")
  });
  assert.equal(queue.options.apiConcurrency, 5);
  assert.equal(queue.options.fallbackConcurrency, 2);

  const injectedQueue = createTwoStageQueue({
    apiConcurrency: 1,
    fallbackConcurrency: 1,
    apiDetect: async (row) => ({
      rowNumber: row.rowNumber,
      status: "存活",
      basis: "detail_api",
      needsFallback: false
    }),
    fallbackDetect: async () => assert.fail("明确存活不应兜底")
  });
  assert.equal(injectedQueue.options.apiConcurrency, 1);
  assert.equal(injectedQueue.options.fallbackConcurrency, 1);
});

test("API 阶段最大同时运行数不超过 apiConcurrency", async () => {
  const tracker = createConcurrencyTracker();
  const queue = createTwoStageQueue({
    apiConcurrency: 2,
    fallbackConcurrency: 1,
    apiDetect: async (row) => {
      const release = tracker.enter();
      await release.waitForRelease;
      release.leave();
      return {
        rowNumber: row.rowNumber,
        status: "存活",
        basis: "detail_api",
        needsFallback: false
      };
    },
    fallbackDetect: async () => assert.fail("明确存活不应兜底")
  });

  const runPromise = queue.run([
    { rowNumber: 2, url: "https://www.douyin.com/video/1" },
    { rowNumber: 3, url: "https://www.douyin.com/video/2" },
    { rowNumber: 4, url: "https://www.douyin.com/video/3" },
    { rowNumber: 5, url: "https://www.douyin.com/video/4" }
  ]);

  await tracker.waitForActive(2);
  await pause(20);
  assert.equal(tracker.maxActive, 2);
  tracker.releaseAll();
  await runPromise;

  assert.equal(tracker.maxActive, 2);
  assert.equal(tracker.entered, 4);
});

test("fallback 阶段最大同时运行数不超过 fallbackConcurrency", async () => {
  const tracker = createConcurrencyTracker();
  const queue = createTwoStageQueue({
    apiConcurrency: 4,
    fallbackConcurrency: 2,
    apiDetect: async (row) => ({
      rowNumber: row.rowNumber,
      status: "待确认",
      basis: "detail_api",
      needsFallback: true
    }),
    fallbackDetect: async (row) => {
      const release = tracker.enter();
      await release.waitForRelease;
      release.leave();
      return {
        rowNumber: row.rowNumber,
        status: "失效",
        basis: "dom_text",
        stage: "fallback"
      };
    }
  });

  const runPromise = queue.run([
    { rowNumber: 2, url: "https://www.douyin.com/video/1" },
    { rowNumber: 3, url: "https://www.douyin.com/video/2" },
    { rowNumber: 4, url: "https://www.douyin.com/video/3" },
    { rowNumber: 5, url: "https://www.douyin.com/video/4" }
  ]);

  await tracker.waitForActive(2);
  await pause(20);
  assert.equal(tracker.maxActive, 2);
  tracker.releaseAll();
  await runPromise;

  assert.equal(tracker.maxActive, 2);
  assert.equal(tracker.entered, 4);
});

test("stop 后不再启动新项目且未开始行标记为跳过", async () => {
  let calls = 0;
  const queue = createTwoStageQueue({
    apiConcurrency: 1,
    fallbackConcurrency: 1,
    apiDetect: async (row, controls) => {
      calls += 1;
      controls.stop();
      return {
        rowNumber: row.rowNumber,
        status: "待确认",
        basis: "stopped",
        needsFallback: false
      };
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
  assert.equal(results[1].remark, "任务停止未检测");
});

function createConcurrencyTracker() {
  const releases = [];
  let releaseImmediately = false;
  const tracker = {
    active: 0,
    entered: 0,
    maxActive: 0,
    enter() {
      tracker.active += 1;
      tracker.entered += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      let resolveRelease;
      const waitForRelease = new Promise((resolve) => {
        resolveRelease = resolve;
      });
      const release = {
        waitForRelease,
        leave() {
          tracker.active -= 1;
        },
        release: resolveRelease
      };
      releases.push(release);
      if (releaseImmediately) {
        resolveRelease();
      }
      return release;
    },
    async waitForActive(count) {
      await waitUntil(() => tracker.active >= count, `活跃任务数未达到 ${count}`);
    },
    releaseAll() {
      releaseImmediately = true;
      while (releases.length > 0) {
        releases.shift().release();
      }
    }
  };

  return tracker;
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(message);
    }
    await pause(1);
  }
}

function pause(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
