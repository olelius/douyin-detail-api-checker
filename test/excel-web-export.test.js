import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { once } from "node:events";
import { createTaskManager } from "../src/task-manager.js";
import { createWebServer } from "../src/web-server.js";
import { createDefaultWebDeps } from "../src/start-web.js";
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

test("exportTaskWorkbook 连续导出同一个 inputData 时结果列不重复增长", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-web-export-"));
  const input = path.join(dir, "输入.xlsx");
  const firstOutput = path.join(dir, "output", "第一次.xlsx");
  const secondOutput = path.join(dir, "output", "第二次.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("主表");
  sheet.addRow(["序号", "链接"]);
  sheet.addRow([1, "https://www.douyin.com/video/123"]);
  await workbook.xlsx.writeFile(input);

  const inputData = await readInputWorkbook(input);
  const results = [{
    rowNumber: 2,
    status: "存活",
    finalUrl: "https://www.douyin.com/video/123",
    remark: "连续导出测试",
    checkedAt: "2026-06-24 10:00:00",
    basis: "detail_api"
  }];

  await exportTaskWorkbook({ outputPath: firstOutput, inputData, results });
  await exportTaskWorkbook({ outputPath: secondOutput, inputData, results });

  const exported = new ExcelJS.Workbook();
  await exported.xlsx.readFile(secondOutput);
  const outputSheet = exported.getWorksheet("主表");
  const headers = outputSheet.getRow(1).values.slice(1);
  const resultHeaderCount = headers.filter((header) => OUTPUT_COLUMNS.includes(header)).length;

  assert.equal(outputSheet.columnCount, 7);
  assert.equal(resultHeaderCount, OUTPUT_COLUMNS.length);
  assert.deepEqual(headers.slice(2, 7), OUTPUT_COLUMNS);
});

test("任务导出 payload 保留写出所需数据但快照不泄露大对象", async () => {
  const inputData = {
    workbook: { shouldStayInternal: true },
    worksheet: { shouldStayInternal: true },
    rows: [{ rowNumber: 2, url: "https://www.douyin.com/video/123" }]
  };
  const manager = createTaskManager({
    runQueue: async ({ rows, onResult }) => {
      const result = {
        rowNumber: rows[0].rowNumber,
        status: "存活",
        finalUrl: rows[0].url,
        remark: "本地测试结果",
        checkedAt: "2026-06-24 10:00:00",
        basis: "detail_api"
      };
      onResult(result);
      return [result];
    }
  });

  const task = await manager.createTask({
    inputPath: "input/输入.xlsx",
    outputPath: "output/检测结果.xlsx",
    inputData,
    rows: inputData.rows
  });
  await manager.startTask(task.id);

  const snapshot = manager.getTask(task.id);
  const payload = manager.getTaskExportPayload(task.id);

  assert.equal(Object.hasOwn(snapshot, "inputData"), false);
  assert.equal(Object.hasOwn(snapshot, "rows"), false);
  assert.equal(Object.hasOwn(snapshot, "results"), false);
  assert.equal(payload.outputPath, "output/检测结果.xlsx");
  assert.equal(payload.inputData, inputData);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].status, "存活");
});

test("GET /api/tasks/:id/export 返回 xlsx 下载并限制输出目录", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-web-export-"));
  const outputRoot = path.join(dir, "output");
  const outputPath = path.join(outputRoot, "检测结果.xlsx");
  const exportedBody = Buffer.from("xlsx-body");
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(outputPath, exportedBody);

  const app = createWebServer({
    outputRoot,
    taskManager: {
      getTaskExportPayload(id) {
        assert.equal(id, "task-1");
        return { outputPath, inputData: {}, results: [] };
      }
    },
    exportTaskWorkbook: async (payload) => ({ outputPath: payload.outputPath })
  });
  const { server, baseUrl } = await listen(app);

  try {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/export`);
    const body = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''/);
    assert.deepEqual(body, exportedBody);
  } finally {
    await close(server);
  }
});

test("导出接口拒绝 output 目录外路径且错误不泄露绝对路径或 Cookie", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-web-export-"));
  const outputRoot = path.join(dir, "output");
  const outsidePath = path.join(dir, "outside", "检测结果.xlsx");
  const app = createWebServer({
    outputRoot,
    taskManager: {
      getTaskExportPayload() {
        return { outputPath: outsidePath, inputData: {}, results: [] };
      }
    },
    exportTaskWorkbook: async (payload) => ({ outputPath: payload.outputPath })
  });
  const { server, baseUrl } = await listen(app);

  try {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/export`);
    const json = await response.json();
    const text = JSON.stringify(json);

    assert.equal(response.status, 500);
    assert.equal(json.error, "导出 Excel 失败，请确认输出文件未被占用后重试。");
    assert.equal(text.includes(dir), false);
    assert.equal(text.includes("sessionid"), false);
  } finally {
    await close(server);
  }
});

test("导出写出失败时返回稳定中文错误", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-web-export-"));
  const outputRoot = path.join(dir, "output");
  const outputPath = path.join(outputRoot, "检测结果.xlsx");
  const app = createWebServer({
    outputRoot,
    taskManager: {
      getTaskExportPayload() {
        return { outputPath, inputData: {}, results: [] };
      }
    },
    exportTaskWorkbook: async () => {
      throw new Error(`写入失败：${outputPath} sessionid=secret`);
    }
  });
  const { server, baseUrl } = await listen(app);

  try {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/export`);
    const json = await response.json();
    const text = JSON.stringify(json);

    assert.equal(response.status, 500);
    assert.equal(json.error, "导出 Excel 失败，请确认输出文件未被占用后重试。");
    assert.equal(text.includes(outputPath), false);
    assert.equal(text.includes("secret"), false);
  } finally {
    await close(server);
  }
});

test("导出文件读取失败时返回稳定中文错误且不提前发送 xlsx 头", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-web-export-"));
  const outputRoot = path.join(dir, "output");
  const outputPath = path.join(outputRoot, "检测结果.xlsx");
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(outputPath, "xlsx-body");

  const app = createWebServer({
    outputRoot,
    taskManager: {
      getTaskExportPayload() {
        return { outputPath, inputData: {}, results: [] };
      }
    },
    exportTaskWorkbook: async (payload) => ({ outputPath: payload.outputPath }),
    readExportFile: async () => {
      throw new Error(`读取失败：${outputPath} sessionid=secret`);
    }
  });
  const { server, baseUrl } = await listen(app);

  try {
    const response = await fetch(`${baseUrl}/api/tasks/task-1/export`);
    const json = await response.json();
    const text = JSON.stringify(json);

    assert.equal(response.status, 500);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(json.error, "导出 Excel 失败，请确认输出文件未被占用后重试。");
    assert.equal(text.includes(outputPath), false);
    assert.equal(text.includes("secret"), false);
  } finally {
    await close(server);
  }
});

test("生产默认 Web 依赖注入 exportTaskWorkbook", async () => {
  const deps = createDefaultWebDeps({
    apiDetector: { detect: async () => ({}) },
    fallbackDetector: { detect: async () => ({}), close: async () => {} }
  });

  try {
    assert.equal(typeof deps.exportTaskWorkbook, "function");
  } finally {
    await deps.close();
  }
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
