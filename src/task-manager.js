import { randomUUID } from "node:crypto";
import { classifyDetailResult as defaultClassifyDetailResult } from "./classifier.js";
import { createTwoStageQueue } from "./queue.js";
import { sanitizeProfileMessage, sanitizeProfileUrl } from "./api-profile-cache.js";
import { extractDouyinWorkInfo } from "./url-utils.js";

const MAX_LOGS = 200;
const MAX_RESULT_PAGE_SIZE = 100;
const SAFE_OPTION_KEYS = [
  "apiConcurrency",
  "fallbackConcurrency",
  "timeoutMs",
  "delayMs",
  "enableFallback",
  "apiSeedUrl"
];

export function createTaskManager(options = {}) {
  const tasks = new Map();
  const runQueue = options.runQueue || createInjectedRunQueue(options);
  const apiProfileCache = options.apiProfileCache || null;

  function createTask(payload = {}) {
    const task = buildTask(payload);
    tasks.set(task.id, task);
    addLog(task.id, "信息", "任务已创建。");
    return snapshotTask(task);
  }

  function addLog(id, level, message) {
    const task = requireTask(tasks, id);
    task.logs.push({
      time: new Date().toISOString(),
      level,
      message: sanitizeLogMessage(message)
    });
    task.logs = task.logs.slice(-MAX_LOGS);
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
      if (typeof runQueue !== "function") {
        throw new TypeError("任务管理器必须注入 runQueue 函数。");
      }

      task.status = task.stopRequested ? "停止中" : "检测中";
      task.startedAt = new Date().toISOString();
      task.activeSignal = createStopSignal(task.stopRequested);
      addLog(id, "信息", "任务开始检测。");
      await startApiProfilePrewarm(task, apiProfileCache, (level, message) => addLog(id, level, message));

      try {
        const results = await runQueue({
          rows: task.rows,
          options: task.options,
          signal: task.activeSignal,
          onResult: (result) => applyResult(task, result)
        });
        for (const result of results || []) {
          applyResult(task, result);
        }

        task.finishedAt = new Date().toISOString();
        task.status = task.stopRequested || task.activeSignal.stopped ? "已停止" : "已完成";
        addLog(id, "信息", `任务${task.status}。`);
      } catch (error) {
        task.finishedAt = new Date().toISOString();
        task.status = "失败";
        addLog(id, "错误", `任务执行失败：${sanitizeLogMessage(error?.message || error)}`);
        throw error;
      } finally {
        task.activeSignal = null;
      }

      return snapshotTask(task);
    },
    stopTask(id) {
      const task = requireTask(tasks, id);
      task.stopRequested = true;
      task.status = task.status === "等待中" ? "停止中" : task.status;
      if (task.activeSignal) {
        task.activeSignal.stop();
      }
      addLog(id, "警告", "已请求停止任务。");
      return snapshotTask(task);
    },
    getTask(id) {
      return snapshotTask(requireTask(tasks, id));
    },
    getTaskResults(id, pagination = {}) {
      const task = requireTask(tasks, id);
      const requestedPageSize = normalizePositiveInteger(pagination.pageSize, 20);
      const pageSize = Math.min(requestedPageSize, MAX_RESULT_PAGE_SIZE);
      const page = normalizePositiveInteger(pagination.page, 1);
      const start = (page - 1) * pageSize;
      return {
        taskId: task.id,
        page,
        pageSize,
        total: task.results.length,
        results: clone(task.results.slice(start, start + pageSize))
      };
    },
    getTaskExportPayload(id) {
      const task = requireTask(tasks, id);
      return {
        outputPath: task.outputPath,
        inputData: task.inputData,
        results: clone(task.results)
      };
    },
    addLog
  };
}

function createInjectedRunQueue(options = {}) {
  const apiDetector = options.apiDetector;
  const fallbackDetector = options.fallbackDetector;
  const classify = options.classifyDetailResult || options.classifier || defaultClassifyDetailResult;

  if (!apiDetector || !fallbackDetector) {
    return null;
  }
  if (typeof apiDetector.detect !== "function" || typeof fallbackDetector.detect !== "function") {
    throw new TypeError("apiDetector 和 fallbackDetector 必须提供 detect 函数。");
  }
  if (typeof classify !== "function") {
    throw new TypeError("任务管理器必须注入 classifyDetailResult 函数。");
  }

  return async ({ rows = [], options: taskOptions = {}, signal, onResult } = {}) => {
    const queue = createTwoStageQueue({
      apiConcurrency: taskOptions.apiConcurrency,
      fallbackConcurrency: taskOptions.fallbackConcurrency,
      signal,
      apiDetect: async (row) => classifyDetectorEvidence(
        row,
        await apiDetector.detect(row.url, { row, options: taskOptions, signal }),
        classify,
        "api"
      ),
      fallbackDetect: async (row) => classifyDetectorEvidence(
        row,
        await fallbackDetector.detect(row, { options: taskOptions, signal }),
        classify,
        "fallback"
      )
    });

    try {
      const results = await queue.run(rows);
      for (const result of results) {
        if (typeof onResult === "function") {
          onResult(result);
        }
      }
      return results;
    } finally {
      if (typeof fallbackDetector.close === "function") {
        await fallbackDetector.close();
      }
    }
  };
}

function classifyDetectorEvidence(row, evidence = {}, classify, stage) {
  const classified = classify(evidence);
  return {
    rowNumber: evidence.rowNumber ?? row.rowNumber,
    status: classified.status,
    contentType: classified.contentType,
    finalUrl: evidence.finalUrl || row.url || evidence.originalUrl || "",
    remark: classified.reason,
    checkedAt: evidence.checkedAt,
    basis: classified.basis,
    stage: evidence.stage || stage,
    apiUrl: sanitizeProfileUrl(evidence.apiUrl || ""),
    error: evidence.error || "",
    errorType: evidence.errorType || "",
    needsFallback: evidence.needsFallback === true,
    riskSuspected: evidence.riskSuspected === true,
    apiCacheUsed: evidence.apiCacheUsed ?? row.apiResult?.apiCacheUsed,
    apiProfileStatus: evidence.apiProfileStatus || row.apiResult?.apiProfileStatus || "",
    apiCandidateSource: evidence.apiCandidateSource || row.apiResult?.apiCandidateSource || "",
    apiCandidateSources: evidence.apiCandidateSources || row.apiResult?.apiCandidateSources || []
  };
}

async function startApiProfilePrewarm(task, apiProfileCache, addTaskLog) {
  if (!apiProfileCache || typeof apiProfileCache.ensureProfile !== "function") {
    return;
  }
  await prewarmApiProfile(task, apiProfileCache, addTaskLog);
}

async function prewarmApiProfile(task, apiProfileCache, addTaskLog) {
  const seedUrl = typeof task.options?.apiSeedUrl === "string" ? task.options.apiSeedUrl.trim() : "";
  if (!seedUrl) {
    return;
  }

  const seedInfo = extractDouyinWorkInfo(seedUrl);
  if (!seedInfo.supported) {
    return;
  }

  try {
    const result = await apiProfileCache.ensureProfile(seedUrl);
    if (result?.ok === false) {
      addTaskLog("警告", `参数种子链接预热失败，继续使用旧 HTTP 候选和 Playwright 兜底：${sanitizeLogMessage(result.error || "未知原因")}`);
    } else {
      addTaskLog("信息", "参数种子链接预热完成。");
    }
  } catch (error) {
    addTaskLog("警告", `参数种子链接预热失败，继续使用旧 HTTP 候选和 Playwright 兜底：${sanitizeLogMessage(error?.message || error)}`);
  }
}

function buildTask(payload = {}) {
  const rows = Array.isArray(payload.rows) ? clone(payload.rows) : [];
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    status: "等待中",
    inputPath: payload.inputPath || "",
    outputPath: payload.outputPath || "",
    inputData: payload.inputData || null,
    rows,
    options: clone(payload.options || {}),
    progress: buildProgress(rows.length, 0),
    stats: buildStats(rows.length),
    results: [],
    logs: [],
    stopRequested: false,
    createdAt: now,
    startedAt: "",
    finishedAt: "",
    activeSignal: null
  };
}

function applyResult(task, result = {}) {
  if (result.rowNumber === undefined || result.rowNumber === null) {
    return;
  }
  if (task.results.some((item) => item.rowNumber === result.rowNumber)) {
    return;
  }

  task.results.push(sanitizeTaskResult(result));
  recalculateStats(task);
}

function recalculateStats(task) {
  const stats = buildStats(task.rows.length);
  for (const result of task.results) {
    stats.processed += 1;
    if (result.status === "存活") {
      stats.alive += 1;
    } else if (result.status === "失效") {
      stats.dead += 1;
    } else if (result.status === "待确认") {
      stats.pending += 1;
    } else if (result.status === "跳过") {
      stats.skipped += 1;
    } else {
      stats.failed += 1;
    }

    if (result.stage === "api" || result.basis === "detail_api") {
      stats.apiChecked += 1;
    }
    if (result.stage === "fallback" || result.basis === "dom_text") {
      stats.fallbackChecked += 1;
    }
  }

  task.stats = stats;
  task.progress = buildProgress(stats.total, stats.processed);
}

function buildStats(total) {
  return {
    total,
    processed: 0,
    alive: 0,
    dead: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
    apiChecked: 0,
    fallbackChecked: 0
  };
}

function buildProgress(total, processed) {
  return {
    total,
    processed,
    percent: total > 0 ? Math.round((processed / total) * 100) : 0
  };
}

function createStopSignal(stopped = false) {
  const signal = {
    stopped,
    stop() {
      signal.stopped = true;
    }
  };
  return signal;
}

function snapshotTask(task) {
  return clone({
    id: task.id,
    status: task.status,
    inputPath: task.inputPath,
    outputPath: task.outputPath,
    options: pickSafeOptions(task.options),
    progress: task.progress,
    stats: task.stats,
    logs: task.logs,
    stopRequested: task.stopRequested,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt
  });
}

function requireTask(tasks, id) {
  const task = tasks.get(id);
  if (!task) {
    throw new Error("任务不存在。");
  }
  return task;
}

function normalizePositiveInteger(value, defaultValue) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : defaultValue;
}

function pickSafeOptions(options = {}) {
  const safeOptions = {};
  for (const key of SAFE_OPTION_KEYS) {
    if (options[key] !== undefined) {
      safeOptions[key] = options[key];
    }
  }
  return safeOptions;
}

function sanitizeTaskResult(result = {}) {
  const safeResult = clone(result);
  if (safeResult.apiUrl) {
    safeResult.apiUrl = sanitizeProfileUrl(safeResult.apiUrl);
  }
  return safeResult;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeLogMessage(message) {
  return sanitizeProfileMessage(String(message || "").replace(
    /\b(sessionid|ttwid|sid_guard|uid_tt|passport_csrf_token|msToken|odin_tt|__ac_nonce|__ac_signature)\s*=\s*[^;\s,]+/gi,
    "$1=***"
  ));
}
