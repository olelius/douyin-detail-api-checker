import fs from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { classifyDetailResult } from "./classifier.js";
import { createDetailDetector } from "./detector.js";
import { DEFAULT_INPUT_CANDIDATES, DEFAULT_OPTIONS, DEFAULT_OUTPUT_PATH } from "./config.js";
import { formatLocalDateTime, readInputWorkbook, writeOutputWorkbook } from "./excel.js";

function printHelp() {
  console.log(`抖音链接有效性检测（Node detail API 方案）

用法：
  node src/main.js [输入.xlsx] [输出.xlsx] [选项]

选项：
  --limit <数量>        只检测前 N 条非空链接，适合小批量验证
  --concurrency <数量>  并发数，默认 1，建议保持保守
  --delay <毫秒>        每条链接启动检测前的间隔，默认 1000
  --timeout <毫秒>      页面打开超时，默认 15000
  --help               显示帮助

默认输入查找顺序：
  input/测试.xlsx
  input/test.xlsx
  ../python_playwright_dom_text/test.xlsx

默认输出：
  ${DEFAULT_OUTPUT_PATH}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const inputPath = resolveInputPath(args.inputPath);
  const outputPath = path.resolve(process.cwd(), args.outputPath || DEFAULT_OUTPUT_PATH);
  const options = {
    concurrency: args.concurrency ?? DEFAULT_OPTIONS.concurrency,
    delayMs: args.delayMs ?? DEFAULT_OPTIONS.delayMs,
    timeoutMs: args.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs,
    waitAfterLoadMs: DEFAULT_OPTIONS.waitAfterLoadMs
  };

  if (!inputPath) {
    throw new Error("未找到输入 Excel。请提供输入路径，或放置到 input/测试.xlsx。");
  }

  console.log(`输入文件：${inputPath}`);
  console.log(`输出文件：${outputPath}`);
  console.log(`参数：并发 ${options.concurrency}，间隔 ${options.delayMs}ms，超时 ${options.timeoutMs}ms`);

  const inputData = await readInputWorkbook(inputPath);
  const rowsToDetect = prepareRows(inputData.rows, args.limit);
  const limitSkippedResults = buildLimitSkippedResults(inputData.rows, rowsToDetect, args.limit);
  const detector = createDetailDetector(options);
  const limit = pLimit(options.concurrency);
  const results = [...limitSkippedResults];

  try {
    const tasks = rowsToDetect.map((row, index) => limit(async () => {
      await sleep(index * options.delayMs);
      const result = await detectOne(row, detector, index + 1, rowsToDetect.length);
      results.push(result);
    }));

    await Promise.all(tasks);
  } finally {
    await detector.close();
  }

  await writeOutputWorkbook(outputPath, inputData, results);
  printSummary(inputData.rows, results, outputPath);
}

function parseArgs(argv) {
  const parsed = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--limit") {
      parsed.limit = parsePositiveInteger(argv[++index], "limit");
    } else if (arg === "--concurrency") {
      parsed.concurrency = parsePositiveInteger(argv[++index], "concurrency");
    } else if (arg === "--delay") {
      parsed.delayMs = parseNonNegativeInteger(argv[++index], "delay");
    } else if (arg === "--timeout") {
      parsed.timeoutMs = parsePositiveInteger(argv[++index], "timeout");
    } else if (arg.startsWith("--")) {
      throw new Error(`未知参数：${arg}`);
    } else {
      positional.push(arg);
    }
  }

  parsed.inputPath = positional[0] || "";
  parsed.outputPath = positional[1] || "";
  return parsed;
}

function resolveInputPath(inputPath) {
  if (inputPath) {
    const resolved = path.resolve(process.cwd(), inputPath);
    return fs.existsSync(resolved) ? resolved : "";
  }

  for (const candidate of DEFAULT_INPUT_CANDIDATES) {
    const resolved = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  return "";
}

function prepareRows(rows, limitCount) {
  const nonEmptyRows = rows.filter((row) => row.url);
  if (!limitCount) {
    return nonEmptyRows;
  }
  return nonEmptyRows.slice(0, limitCount);
}

function buildLimitSkippedResults(rows, rowsToDetect, limitCount) {
  if (!limitCount) {
    return [];
  }

  const detectRowNumbers = new Set(rowsToDetect.map((row) => row.rowNumber));
  return rows
    .filter((row) => row.url && !detectRowNumbers.has(row.rowNumber))
    .map((row) => ({
      rowNumber: row.rowNumber,
      status: "跳过",
      finalUrl: row.url,
      remark: "超过 --limit 限制未检测",
      checkedAt: formatLocalDateTime(),
      basis: "skip"
    }));
}

async function detectOne(row, detector, index, total) {
  console.log(`[${index}/${total}] 开始检测：${row.url}`);

  const evidence = await detector.detect(row.url);
  const classification = classifyDetailResult(evidence);
  const result = {
    rowNumber: row.rowNumber,
    status: classification.status,
    contentType: classification.contentType,
    finalUrl: evidence.finalUrl || row.url,
    remark: classification.reason,
    checkedAt: formatLocalDateTime(),
    basis: classification.basis,
    apiUrl: evidence.apiUrl,
    error: evidence.error
  };

  console.log(`[${index}/${total}] ${result.status} / ${result.contentType} / ${result.basis}：${row.url}`);
  return result;
}

function printSummary(allRows, results, outputPath) {
  const counts = {
    总数: allRows.length,
    存活: 0,
    失效: 0,
    待确认: 0,
    跳过: allRows.filter((row) => !row.url).length,
    失败: 0
  };

  for (const result of results) {
    if (Object.hasOwn(counts, result.status)) {
      counts[result.status] += 1;
    } else {
      counts.失败 += 1;
    }
  }

  console.log("检测汇总：");
  for (const [name, value] of Object.entries(counts)) {
    console.log(`  ${name}：${value}`);
  }
  console.log(`结果文件：${outputPath}`);
}

function parsePositiveInteger(value, name) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`参数 --${name} 必须是正整数。`);
  }
  return number;
}

function parseNonNegativeInteger(value, name) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`参数 --${name} 必须是非负整数。`);
  }
  return number;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error(`运行失败：${error.message}`);
  process.exitCode = 1;
});
