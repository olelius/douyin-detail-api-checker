import { DEFAULT_API_OPTIONS, DEFAULT_FALLBACK_OPTIONS } from "./config.js";
import { formatLocalDateTime } from "./excel.js";

const FALLBACK_ERROR_TYPES = new Set([
  "unsupported_url",
  "fetch_unavailable",
  "timeout",
  "request_error",
  "http_status",
  "risk_control",
  "api_candidates_failed",
  "no_api_candidate"
]);

export function createTwoStageQueue(options = {}) {
  if (typeof options.apiDetect !== "function") {
    throw new TypeError("队列必须注入 apiDetect 函数。");
  }
  if (typeof options.fallbackDetect !== "function") {
    throw new TypeError("队列必须注入 fallbackDetect 函数。");
  }

  const queueOptions = {
    apiConcurrency: normalizeConcurrency(options.apiConcurrency, DEFAULT_API_OPTIONS.concurrency),
    fallbackConcurrency: normalizeConcurrency(options.fallbackConcurrency, DEFAULT_FALLBACK_OPTIONS.concurrency)
  };
  const controls = createStopSignal(options.signal);

  return {
    controls,
    options: queueOptions,
    stop: controls.stop,
    async run(rows = []) {
      const normalizedRows = Array.isArray(rows) ? rows : [];
      const resultsByKey = new Map();
      const startedKeys = new Set();
      const fallbackRows = [];

      await runWorkers({
        rows: normalizedRows,
        concurrency: queueOptions.apiConcurrency,
        controls,
        startedKeys,
        worker: async (row) => {
          try {
            const apiResult = await options.apiDetect(row, controls);
            if (shouldFallback(apiResult)) {
              fallbackRows.push({ ...row, apiResult });
              return;
            }
            setResult(resultsByKey, row, normalizeResult(row, apiResult, "api"));
          } catch (error) {
            fallbackRows.push({
              ...row,
              apiResult: {
                rowNumber: row.rowNumber,
                status: "待确认",
                basis: "detail_api",
                needsFallback: true,
                errorType: "api_exception",
                error: sanitizeErrorMessage(error)
              }
            });
          }
        }
      });

      for (const row of normalizedRows) {
        const key = getRowKey(row);
        if (!startedKeys.has(key) && !resultsByKey.has(key)) {
          setResult(resultsByKey, row, buildStoppedResult(row));
        }
      }

      const fallbackStartedKeys = new Set();
      await runWorkers({
        rows: fallbackRows,
        concurrency: queueOptions.fallbackConcurrency,
        controls,
        startedKeys: fallbackStartedKeys,
        worker: async (row) => {
          try {
            const fallbackResult = await options.fallbackDetect(row, controls);
            setResult(resultsByKey, row, normalizeResult(row, fallbackResult, "fallback"));
          } catch (error) {
            setResult(resultsByKey, row, buildFailedResult(row, error));
          }
        }
      });

      for (const row of fallbackRows) {
        const key = getRowKey(row);
        if (!fallbackStartedKeys.has(key) && !resultsByKey.has(key)) {
          setResult(resultsByKey, row, buildStoppedResult(row));
        }
      }

      return normalizedRows
        .map((row) => resultsByKey.get(getRowKey(row)))
        .filter(Boolean);
    }
  };
}

function createStopSignal(parentSignal) {
  const controls = {
    stopped: Boolean(parentSignal?.stopped),
    stop() {
      controls.stopped = true;
      if (typeof parentSignal?.stop === "function") {
        parentSignal.stop();
      } else if (parentSignal && "stopped" in parentSignal) {
        parentSignal.stopped = true;
      }
    }
  };
  return controls;
}

async function runWorkers({ rows, concurrency, controls, startedKeys, worker }) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, rows.length);

  async function runOneWorker() {
    while (!controls.stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= rows.length) {
        return;
      }

      const row = rows[index];
      startedKeys.add(getRowKey(row));
      await worker(row);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runOneWorker()));
}

function shouldFallback(result = {}) {
  if (result?.needsFallback === true) {
    return true;
  }
  if (result?.status === "待确认") {
    return true;
  }
  if (result?.riskSuspected === true) {
    return true;
  }
  if (typeof result?.errorType === "string" && FALLBACK_ERROR_TYPES.has(result.errorType)) {
    return true;
  }
  return false;
}

function normalizeResult(row, result = {}, stage) {
  return {
    rowNumber: result.rowNumber ?? row.rowNumber,
    status: result.status || "待确认",
    contentType: result.contentType || "",
    finalUrl: result.finalUrl || row.url || "",
    remark: result.remark || result.reason || result.error || "",
    checkedAt: result.checkedAt || formatLocalDateTime(),
    basis: result.basis || (stage === "api" ? "detail_api" : "dom_text"),
    stage: result.stage || stage,
    ...result
  };
}

function buildStoppedResult(row) {
  return {
    rowNumber: row.rowNumber,
    status: "跳过",
    finalUrl: row.url || "",
    remark: "任务停止未检测",
    checkedAt: formatLocalDateTime(),
    basis: "stopped",
    stage: "stopped"
  };
}

function buildFailedResult(row, error) {
  return {
    rowNumber: row.rowNumber,
    status: "失败",
    finalUrl: row.url || "",
    remark: sanitizeErrorMessage(error),
    checkedAt: formatLocalDateTime(),
    basis: "error",
    stage: "fallback"
  };
}

function setResult(resultsByKey, row, result) {
  const key = getRowKey(row);
  if (!resultsByKey.has(key)) {
    resultsByKey.set(key, result);
  }
}

function getRowKey(row) {
  return String(row?.rowNumber ?? row?.url ?? "");
}

function normalizeConcurrency(value, defaultValue) {
  const number = Number(value ?? defaultValue);
  return Number.isInteger(number) && number > 0 ? number : defaultValue;
}

function sanitizeErrorMessage(error) {
  const message = error?.message || String(error || "未知错误");
  return message.replace(
    /\b(sessionid|ttwid|sid_guard|uid_tt|passport_csrf_token|msToken|odin_tt|__ac_nonce|__ac_signature)\s*=\s*[^;\s,]+/gi,
    "$1=***"
  );
}
