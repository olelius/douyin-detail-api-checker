import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";

export const OUTPUT_COLUMNS = ["状态", "最终链接", "备注", "检测时间", "检测依据"];

const HEADER_KEYWORDS = ["链接", "URL", "url", "地址"];
const URL_KEYWORDS = ["douyin.com", "/video/", "/note/", "/share/video/"];

export async function readInputWorkbook(inputPath) {
  if (!inputPath || typeof inputPath !== "string") {
    throw new TypeError("输入 Excel 路径必须是非空字符串。");
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("输入 Excel 中没有可读取的工作表。");
  }

  const headerRow = worksheet.getRow(1);
  const headers = getRowValues(headerRow);
  const sourceColumnCount = worksheet.columnCount;
  const linkColumn = detectLinkColumn(worksheet, headers);
  if (!linkColumn) {
    throw new Error("未识别到链接列，请确认表头包含“链接”“URL”或单元格包含抖音链接。");
  }

  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) {
      return;
    }

    rows.push({
      rowNumber,
      rawValues: getRowValues(row),
      url: normalizeCellValue(row.getCell(linkColumn).value),
      originalRow: row
    });
  });

  return {
    inputPath,
    workbook,
    worksheet,
    headers,
    sourceColumnCount,
    linkColumn,
    rows
  };
}

export async function writeOutputWorkbook(outputPath, inputData, results = []) {
  if (!outputPath || typeof outputPath !== "string") {
    throw new TypeError("输出 Excel 路径必须是非空字符串。");
  }

  if (!inputData?.workbook || !inputData?.worksheet) {
    throw new TypeError("写出 Excel 需要 readInputWorkbook 返回的输入数据。");
  }

  const workbook = inputData.workbook;
  const worksheet = inputData.worksheet;
  const sourceColumnCount = getSourceColumnCount(inputData, worksheet);
  const resultByRow = new Map(results.map((result) => [result.rowNumber, result]));

  appendOutputHeaders(worksheet, sourceColumnCount);

  for (const inputRow of inputData.rows) {
    const row = worksheet.getRow(inputRow.rowNumber);
    const result = resultByRow.get(inputRow.rowNumber) || buildSkippedResult(inputRow);
    writeResultColumns(row, sourceColumnCount, result);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  return {
    outputPath,
    count: inputData.rows.length
  };
}

export async function exportTaskWorkbook({ outputPath, inputData, results }) {
  return writeOutputWorkbook(outputPath, inputData, results);
}

export function formatLocalDateTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds())
  ].join("");
}

function detectLinkColumn(worksheet, headers) {
  const exactIndex = headers.findIndex((header) => header === "链接");
  if (exactIndex >= 0) {
    return exactIndex + 1;
  }

  const keywordIndex = headers.findIndex((header) => HEADER_KEYWORDS.some((keyword) => header.includes(keyword)));
  if (keywordIndex >= 0) {
    return keywordIndex + 1;
  }

  const maxRows = Math.min(worksheet.rowCount, 10);
  for (let rowNumber = 1; rowNumber <= maxRows; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    for (let column = 1; column <= row.cellCount; column += 1) {
      const value = normalizeCellValue(row.getCell(column).value);
      if (URL_KEYWORDS.some((keyword) => value.includes(keyword))) {
        return column;
      }
    }
  }

  return 0;
}

function appendOutputHeaders(worksheet, sourceColumnCount) {
  const header = worksheet.getRow(1);
  OUTPUT_COLUMNS.forEach((columnName, index) => {
    header.getCell(sourceColumnCount + index + 1).value = columnName;
  });
}

function getSourceColumnCount(inputData, worksheet) {
  const count = Number(inputData.sourceColumnCount);
  return Number.isInteger(count) && count > 0 ? count : worksheet.columnCount;
}

function writeResultColumns(row, sourceColumnCount, result) {
  row.getCell(sourceColumnCount + 1).value = result.status || "";
  row.getCell(sourceColumnCount + 2).value = result.finalUrl || "";
  row.getCell(sourceColumnCount + 3).value = result.remark || result.reason || "";
  row.getCell(sourceColumnCount + 4).value = result.checkedAt || formatLocalDateTime();
  row.getCell(sourceColumnCount + 5).value = result.basis || "";
}

function buildSkippedResult(inputRow) {
  if (!inputRow.url) {
    return {
      rowNumber: inputRow.rowNumber,
      status: "跳过",
      finalUrl: "",
      remark: "链接为空",
      checkedAt: formatLocalDateTime(),
      basis: "skip"
    };
  }

  return {
    rowNumber: inputRow.rowNumber,
    status: "待确认",
    finalUrl: inputRow.url,
    remark: "未生成检测结果",
    checkedAt: formatLocalDateTime(),
    basis: "error"
  };
}

function getRowValues(row) {
  const values = [];
  for (let column = 1; column <= row.cellCount; column += 1) {
    values.push(normalizeCellValue(row.getCell(column).value));
  }
  return values;
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text.trim();
    }
    if (typeof value.hyperlink === "string") {
      return value.hyperlink.trim();
    }
    if (Array.isArray(value.richText)) {
      return value.richText.map((item) => item.text || "").join("").trim();
    }
    if (value.result !== undefined) {
      return normalizeCellValue(value.result);
    }
  }

  return String(value).trim();
}
