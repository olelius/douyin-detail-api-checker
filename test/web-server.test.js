import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { createWebServer } from "../src/web-server.js";
import { formatStartupError } from "../src/start-web.js";

test("POST /api/tasks JSON 参数会 trim 并透传参数种子链接", async () => {
  const taskManager = createFakeTaskManager();
  const app = createWebServer({ taskManager });
  const { server, baseUrl } = await listen(app);
  const seedUrl = "https://www.douyin.com/video/7607987902190013723";

  try {
    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/123" }],
        options: { apiSeedUrl: `  ${seedUrl}  ` }
      })
    });
    const created = await response.json();

    assert.equal(response.status, 201);
    assert.equal(created.options.apiSeedUrl, seedUrl);
    assert.equal(taskManager.lastPayload.options.apiSeedUrl, seedUrl);
  } finally {
    await close(server);
  }
});

test("POST /api/tasks multipart 参数会 trim 并透传参数种子链接", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-web-seed-upload-"));
  const uploadRoot = path.join(dir, "uploads");
  const outputRoot = path.join(dir, "output");
  const input = path.join(dir, "seed.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("链接");
  const seedUrl = "https://www.douyin.com/video/7607987902190013723";
  sheet.addRow(["序号", "链接"]);
  sheet.addRow([1, "https://www.douyin.com/video/123"]);
  await workbook.xlsx.writeFile(input);

  const taskManager = createFakeTaskManager();
  const app = createWebServer({ taskManager, uploadRoot, outputRoot });
  const { server, baseUrl } = await listen(app);

  try {
    const formData = new FormData();
    formData.append("file", new Blob([await fs.readFile(input)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }), "seed.xlsx");
    formData.append("options", JSON.stringify({ apiSeedUrl: `  ${seedUrl}  ` }));

    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      body: formData
    });
    const created = await response.json();

    assert.equal(response.status, 201);
    assert.equal(created.options.apiSeedUrl, seedUrl);
    assert.equal(taskManager.lastPayload.options.apiSeedUrl, seedUrl);
  } finally {
    await close(server);
  }
});

test("GET /api/health 返回中文健康状态且不泄露 Cookie 明文", async () => {
  const absolutePath = "D:\\hongye\\douyin_url\\methods\\node_detail_api\\.local\\cookies.json";
  const app = createWebServer({
    version: "0.1.0-test",
    taskManager: {},
    cookieStore: {
      getStatus: async () => ({
        exists: true,
        summary: "2 个 Cookie",
        storagePath: absolutePath,
        cookieHeader: "sessionid=secret; ttwid=secret2"
      })
    }
  });
  const { server, baseUrl } = await listen(app);

  try {
    const response = await fetch(`${baseUrl}/api/health`);
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.status, "正常");
    assert.equal(json.host, "127.0.0.1");
    assert.equal(json.port > 0, true);
    assert.equal(json.version, "0.1.0-test");
    const text = JSON.stringify(json);
    assert.equal(text.includes("secret"), false);
    assert.equal(text.includes("storagePath"), false);
    assert.equal(text.includes(absolutePath), false);
    assert.equal(text.includes("D:\\hongye"), false);
    assert.equal(Object.hasOwn(json.cookie, "storagePath"), false);
  } finally {
    await close(server);
  }
});

test("未知 API 返回中文 404", async () => {
  const app = createWebServer({ version: "test" });
  const { server, baseUrl } = await listen(app);

  try {
    const response = await fetch(`${baseUrl}/api/missing`);
    const json = await response.json();

    assert.equal(response.status, 404);
    assert.match(json.error, /接口不存在/);
  } finally {
    await close(server);
  }
});

test("Cookie 状态接口只返回脱敏摘要", async () => {
  const absolutePath = "D:\\hongye\\douyin_url\\methods\\node_detail_api\\.local\\cookies.json";
  const app = createWebServer({
    cookieStore: {
      getStatus: async () => ({
        exists: true,
        summary: "3 个 Cookie",
        refreshedAt: "2026-06-24T10:00:00.000Z",
        storagePath: absolutePath,
        cookieHeader: "sessionid=secret; passport_csrf_token=token"
      })
    }
  });
  const { server, baseUrl } = await listen(app);

  try {
    const response = await fetch(`${baseUrl}/api/cookie/status`);
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(json.exists, true);
    assert.equal(json.summary, "3 个 Cookie");
    const text = JSON.stringify(json);
    assert.equal(text.includes("secret"), false);
    assert.equal(text.includes("token"), false);
    assert.equal(text.includes("storagePath"), false);
    assert.equal(text.includes(absolutePath), false);
    assert.equal(text.includes("D:\\hongye"), false);
    assert.equal(Object.hasOwn(json, "cookieHeader"), false);
    assert.equal(Object.hasOwn(json, "storagePath"), false);
  } finally {
    await close(server);
  }
});

test("API 500 错误不泄露底层绝对路径或堆栈", async () => {
  const absolutePath = "D:\\hongye\\douyin_url\\methods\\node_detail_api\\.local\\cookies.json";
  const app = createWebServer({
    cookieStore: {
      getStatus: async () => {
        const error = new Error(`Cookie 文件读取失败：${absolutePath}`);
        error.stack = `Error: Cookie 文件读取失败：${absolutePath}\n    at readFile (${absolutePath}:1:1)`;
        throw error;
      }
    }
  });
  const { server, baseUrl } = await listen(app);

  try {
    const response = await fetch(`${baseUrl}/api/cookie/status`);
    const json = await response.json();
    const text = JSON.stringify(json);

    assert.equal(response.status, 500);
    assert.equal(json.error, "服务处理失败，请查看本地日志。");
    assert.equal(text.includes(absolutePath), false);
    assert.equal(text.includes("D:\\hongye"), false);
    assert.equal(text.includes("readFile"), false);
    assert.equal(text.includes("stack"), false);
  } finally {
    await close(server);
  }
});

test("Cookie 刷新接口触发无登录游客 Cookie 刷新并只返回脱敏摘要", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-cookie-api-"));
  const { createCookieStore } = await import("../src/cookie-store.js");
  const cookieStore = createCookieStore({ storagePath: path.join(dir, "cookies.json") });
  let refreshCalls = 0;
  const app = createWebServer({
    cookieStore,
    cookieRefresher: {
      async refresh() {
        refreshCalls += 1;
        await cookieStore.saveCookieHeader("ttwid=visitor-secret; msToken=token-secret");
        return cookieStore.getStatus();
      }
    }
  });
  const { server, baseUrl } = await listen(app);

  try {
    const response = await fetch(`${baseUrl}/api/cookie/refresh`, { method: "POST" });
    const json = await response.json();
    const saved = await cookieStore.getCookieHeader();
    const text = JSON.stringify(json);

    assert.equal(response.status, 200);
    assert.equal(refreshCalls, 1);
    assert.equal(saved, "ttwid=visitor-secret; msToken=token-secret");
    assert.equal(json.status, "已刷新");
    assert.equal(json.cookie.exists, true);
    assert.equal(json.cookie.summary, "2 个 Cookie");
    assert.equal(text.includes("visitor-secret"), false);
    assert.equal(text.includes("token-secret"), false);
    assert.equal(text.includes("storagePath"), false);
    assert.equal(text.includes(cookieStore.storagePath), false);
    assert.equal(Object.hasOwn(json.cookie, "storagePath"), false);
  } finally {
    await close(server);
  }
});

test("已知 API 路径的不支持方法返回 405 和 Allow 头", async () => {
  const app = createWebServer();
  const { server, baseUrl } = await listen(app);

  try {
    const healthResponse = await fetch(`${baseUrl}/api/health`, { method: "POST" });
    const healthJson = await healthResponse.json();
    assert.equal(healthResponse.status, 405);
    assert.equal(healthResponse.headers.get("allow"), "GET");
    assert.match(healthJson.error, /请求方法不支持/);

    const tasksResponse = await fetch(`${baseUrl}/api/tasks`);
    const tasksJson = await tasksResponse.json();
    assert.equal(tasksResponse.status, 405);
    assert.equal(tasksResponse.headers.get("allow"), "POST");
    assert.match(tasksJson.error, /请求方法不支持/);
  } finally {
    await close(server);
  }
});

test("任务接口支持创建、查询、读取结果和停止", async () => {
  const taskManager = createFakeTaskManager();
  const app = createWebServer({ taskManager });
  const { server, baseUrl } = await listen(app);

  try {
    const createResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/123" }],
        options: { apiConcurrency: 5, cookieHeader: "sessionid=secret" }
      })
    });
    const created = await createResponse.json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.status, "等待中");
    assert.equal(JSON.stringify(created).includes("secret"), false);

    const taskResponse = await fetch(`${baseUrl}/api/tasks/${created.id}`);
    assert.equal(taskResponse.status, 200);
    assert.equal((await taskResponse.json()).id, created.id);

    const resultsResponse = await fetch(`${baseUrl}/api/tasks/${created.id}/results?page=1&pageSize=5`);
    const results = await resultsResponse.json();
    assert.equal(resultsResponse.status, 200);
    assert.equal(results.total, 1);
    assert.equal(results.results[0].status, "存活");

    const stopResponse = await fetch(`${baseUrl}/api/tasks/${created.id}/stop`, { method: "POST" });
    const stopped = await stopResponse.json();
    assert.equal(stopResponse.status, 200);
    assert.equal(stopped.status, "已停止");
  } finally {
    await close(server);
  }
});

test("静态资源只允许读取 web 目录内文件并拦截路径穿越", async () => {
  const app = createWebServer();
  const { server, baseUrl } = await listen(app);

  try {
    const indexResponse = await fetch(`${baseUrl}/`);
    const indexText = await indexResponse.text();
    assert.equal(indexResponse.status, 200);
    assert.match(indexResponse.headers.get("content-type"), /text\/html/);
    assert.match(indexText, /抖音链接检测/);

    const traversalResponse = await fetch(`${baseUrl}/..%2fpackage.json`);
    const traversalJson = await traversalResponse.json();
    assert.equal(traversalResponse.status, 403);
    assert.match(traversalJson.error, /不允许访问/);
  } finally {
    await close(server);
  }
});

test("启动错误格式化在端口占用时返回中文提示", () => {
  const message = formatStartupError({ code: "EADDRINUSE", message: "listen EADDRINUSE" }, 3000);
  assert.match(message, /端口 3000 已被占用/);
  assert.match(message, /不会自动切换端口/);
});

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function createFakeTaskManager() {
  const tasks = new Map();
  const manager = {
    createdCount: 0,
    startedIds: [],
    lastPayload: null,
    async createTask(payload) {
      manager.createdCount += 1;
      manager.lastPayload = payload;
      assert.doesNotThrow(() => JSON.stringify(payload.rows));
      if (payload.rows.length > 0) {
        assert.equal(Object.hasOwn(payload.rows[0], "originalRow"), false);
      }
      const task = {
        id: "task-1",
        status: "等待中",
        options: {
          apiConcurrency: payload.options?.apiConcurrency,
          apiSeedUrl: payload.options?.apiSeedUrl
        },
        progress: { total: payload.rows.length, processed: 0, percent: 0 },
        stats: { total: payload.rows.length, processed: 0 },
        logs: []
      };
      tasks.set(task.id, task);
      return task;
    },
    async startTask(id) {
      manager.startedIds.push(id);
      const task = tasks.get(id);
      task.status = "done";
      task.progress = { total: 1, processed: 1, percent: 100 };
      task.stats = { total: 1, processed: 1, alive: 1 };
      return task;
    },
    getTask(id) {
      return tasks.get(id);
    },
    getTaskResults(id, pagination) {
      assert.equal(id, "task-1");
      return {
        taskId: id,
        page: pagination.page,
        pageSize: pagination.pageSize,
        total: 1,
        results: [{ rowNumber: 2, status: "存活", basis: "detail_api" }]
      };
    },
    stopTask(id) {
      const task = tasks.get(id);
      task.status = "已停止";
      return task;
    }
  };
  return manager;
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

test("POST /api/tasks 创建任务后会异步启动检测", async () => {
  const taskManager = createFakeTaskManager();
  const app = createWebServer({ taskManager });
  const { server, baseUrl } = await listen(app);

  try {
    const createResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/123" }],
        options: { apiConcurrency: 1, fallbackConcurrency: 1 }
      })
    });
    const created = await createResponse.json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.id, "task-1");
    await waitUntil(() => taskManager.startedIds.includes("task-1"), "任务未自动启动");
  } finally {
    await close(server);
  }
});

test("POST /api/tasks 没有 rows 时返回中文错误且不创建任务", async () => {
  const taskManager = createFakeTaskManager();
  const app = createWebServer({ taskManager });
  const { server, baseUrl } = await listen(app);

  try {
    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows: [], options: {} })
    });
    const json = await response.json();

    assert.equal(response.status, 400);
    assert.match(json.error, /请提供待检测链接/);
    assert.equal(taskManager.createdCount, 0);
    assert.equal(taskManager.startedIds.length, 0);
  } finally {
    await close(server);
  }
});

test("POST /api/tasks 支持上传 Excel 文件并创建启动任务", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-web-upload-"));
  const uploadRoot = path.join(dir, "uploads");
  const outputRoot = path.join(dir, "output");
  const input = path.join(dir, "待检测.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("链接");
  sheet.addRow(["序号", "链接"]);
  sheet.addRow([1, "https://www.douyin.com/video/123"]);
  await workbook.xlsx.writeFile(input);

  const taskManager = createFakeTaskManager();
  const app = createWebServer({ taskManager, uploadRoot, outputRoot });
  const { server, baseUrl } = await listen(app);

  try {
    const formData = new FormData();
    formData.append("file", new Blob([await fs.readFile(input)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }), "待检测.xlsx");
    formData.append("options", JSON.stringify({ apiConcurrency: 2, fallbackConcurrency: 1 }));

    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      body: formData
    });
    const created = await response.json();

    assert.equal(response.status, 201);
    assert.equal(created.id, "task-1");
    assert.equal(taskManager.lastPayload.rows.length, 1);
    assert.equal(taskManager.lastPayload.rows[0].url, "https://www.douyin.com/video/123");
    assert.equal(taskManager.lastPayload.options.apiConcurrency, 2);
    assert.equal(taskManager.lastPayload.inputPath.startsWith(uploadRoot), true);
    assert.equal(taskManager.lastPayload.outputPath.startsWith(outputRoot), true);
    assert.equal(taskManager.lastPayload.inputData.rows.length, 1);
    await waitUntil(() => taskManager.startedIds.includes("task-1"), "上传任务未自动启动");
  } finally {
    await close(server);
  }
});
