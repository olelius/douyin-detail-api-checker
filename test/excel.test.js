import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  OUTPUT_COLUMNS,
  formatLocalDateTime,
  readInputWorkbook,
  writeOutputWorkbook
} from "../src/excel.js";

async function createWorkbook(filePath, headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("测试数据");
  sheet.addRow(headers);
  for (const row of rows) {
    sheet.addRow(row);
  }
  await workbook.xlsx.writeFile(filePath);
}

test("读取 Excel 时优先识别表头为链接的列", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-excel-"));
  const input = path.join(dir, "输入.xlsx");
  await createWorkbook(input, ["序号", "平台", "链接"], [
    [1, "抖音", "https://www.douyin.com/video/123"]
  ]);

  const data = await readInputWorkbook(input);

  assert.equal(data.linkColumn, 3);
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].url, "https://www.douyin.com/video/123");
});

test("读取 Excel 时可以识别 URL 类表头", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-excel-"));
  const input = path.join(dir, "输入.xlsx");
  await createWorkbook(input, ["序号", "作品URL"], [
    [1, "https://www.douyin.com/note/abc"]
  ]);

  const data = await readInputWorkbook(input);

  assert.equal(data.linkColumn, 2);
  assert.equal(data.rows[0].url, "https://www.douyin.com/note/abc");
});

test("写出 Excel 时保留原始列并追加中文结果列", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-excel-"));
  const input = path.join(dir, "输入.xlsx");
  const output = path.join(dir, "输出", "检测结果.xlsx");
  await createWorkbook(input, ["序号", "链接"], [
    [1, "https://www.douyin.com/video/123"],
    [2, ""]
  ]);
  const data = await readInputWorkbook(input);

  await writeOutputWorkbook(output, data, [
    {
      rowNumber: 2,
      status: "存活",
      finalUrl: "https://www.douyin.com/video/123",
      remark: "detail API 返回有效作品数据",
      checkedAt: "2026-06-23 18:00:00",
      basis: "detail_api"
    }
  ]);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  const sheet = workbook.worksheets[0];
  const headers = sheet.getRow(1).values.slice(1);

  for (const column of OUTPUT_COLUMNS) {
    assert.ok(headers.includes(column));
  }
  assert.equal(sheet.getRow(2).getCell(3).value, "存活");
  assert.equal(sheet.getRow(3).getCell(3).value, "跳过");
  assert.equal(sheet.getRow(3).getCell(5).value, "链接为空");
});


test("writeOutputWorkbook preserves workbook sheets, formulas, hyperlinks, styles, widths and appends result columns", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-excel-"));
  const input = path.join(dir, "input.xlsx");
  const output = path.join(dir, "out", "result.xlsx");

  const sourceWorkbook = new ExcelJS.Workbook();
  const sheet = sourceWorkbook.addWorksheet("主表");
  const extraSheet = sourceWorkbook.addWorksheet("说明");
  sheet.columns = [
    { header: "序号", key: "id", width: 18 },
    { header: "链接", key: "url", width: 48 },
    { header: "计算", key: "formula", width: 20 }
  ];
  sheet.getCell("A1").font = { bold: true, color: { argb: "FFFF0000" } };
  sheet.getCell("A2").value = 1;
  sheet.getCell("B2").value = {
    text: "抖音链接",
    hyperlink: "https://www.douyin.com/video/123"
  };
  sheet.getCell("C2").value = { formula: "A2+1", result: 2 };
  sheet.mergeCells("A4:B4");
  sheet.getCell("A4").value = "合并单元格";
  extraSheet.getCell("A1").value = "其他工作表内容";
  await sourceWorkbook.xlsx.writeFile(input);

  const data = await readInputWorkbook(input);
  await writeOutputWorkbook(output, data, [
    {
      rowNumber: 2,
      status: "存活",
      finalUrl: "https://www.douyin.com/video/123",
      remark: "detail API 返回有效作品数据",
      checkedAt: "2026-06-23 18:00:00",
      basis: "detail_api"
    }
  ]);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(output);
  const outputSheet = workbook.getWorksheet("主表");
  const outputExtraSheet = workbook.getWorksheet("说明");

  assert.ok(outputSheet);
  assert.ok(outputExtraSheet);
  assert.equal(outputExtraSheet.getCell("A1").value, "其他工作表内容");
  assert.equal(outputSheet.getColumn(2).width, 48);
  assert.deepEqual(outputSheet.getCell("A1").font, { bold: true, color: { argb: "FFFF0000" } });
  assert.equal(outputSheet.getCell("B2").value.hyperlink, "https://www.douyin.com/video/123");
  assert.equal(outputSheet.getCell("C2").value.formula, "A2+1");
  assert.equal(outputSheet.getCell("A4").isMerged, true);

  const headers = outputSheet.getRow(1).values.slice(1);
  assert.deepEqual(headers.slice(3, 8), OUTPUT_COLUMNS);
  assert.equal(outputSheet.getRow(2).getCell(4).value, "存活");
  assert.equal(outputSheet.getRow(2).getCell(8).value, "detail_api");
});
test("本地时间格式为中文表格可读的固定格式", () => {
  const text = formatLocalDateTime(new Date("2026-06-23T10:09:08+08:00"));

  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
