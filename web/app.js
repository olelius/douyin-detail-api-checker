const STAT_ITEMS = [
  ["total", "总数"],
  ["processed", "已处理"],
  ["alive", "存活"],
  ["dead", "失效"],
  ["pending", "待确认"],
  ["skipped", "跳过"],
  ["failed", "失败"],
  ["apiChecked", "API 命中"],
  ["fallbackChecked", "兜底数量"]
];

const GENERIC_REQUEST_ERROR = "请求失败，请查看服务日志。";
const COOKIE_PAIR_PATTERN = /\b(sessionid|sid_guard|uid_tt|ttwid|passport_csrf_token|msToken|odin_tt|__ac_nonce|__ac_signature)\s*=\s*[^;\s,"]+/gi;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\[^\r\n"'<>]+/g;
const STACK_LINE_PATTERN = /^\s*at\s+.*$/gmi;

export function formatTaskStatus(task) {
  return task?.status || "未创建任务";
}

export function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      query.append(key, String(value));
    }
  }
  return query.toString();
}

export function createInitialState() {
  return { taskId: "", polling: null, page: 1, pageSize: 50 };
}

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const json = parseJsonOrNull(text);
  if (!response.ok) {
    throw new Error(sanitizeDisplayError(json?.error || GENERIC_REQUEST_ERROR));
  }
  if (json === null) {
    throw new Error(GENERIC_REQUEST_ERROR);
  }
  return json;
}

export function sanitizeDisplayError(message) {
  const sanitized = String(message || "")
    .replace(COOKIE_PAIR_PATTERN, "$1=***")
    .replace(WINDOWS_PATH_PATTERN, "[本地路径]")
    .replace(STACK_LINE_PATTERN, "")
    .replace(/\b(stack|Stack trace)\b\s*:?/gi, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return sanitized || GENERIC_REQUEST_ERROR;
}

export function recoverStopButtonAfterFailure(state, elements) {
  if (isRunningTask(state?.currentTask)) {
    elements.stopButton.disabled = false;
    return true;
  }
  return false;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    const state = createInitialState();
    const elements = collectElements();

    renderStats(elements.statsGrid, {});
    renderLog(elements.logList, []);
    bindActions(state, elements);
    refreshHealth(elements);
  });
}

function collectElements() {
  return {
    serviceStatus: document.getElementById("serviceStatus"),
    cookieStatus: document.getElementById("cookieStatus"),
    taskStatus: document.getElementById("taskStatus"),
    refreshCookieButton: document.getElementById("refreshCookieButton"),
    exportLink: document.getElementById("exportLink"),
    fileInput: document.getElementById("fileInput"),
    apiConcurrency: document.getElementById("apiConcurrency"),
    apiSeedUrl: document.getElementById("apiSeedUrl"),
    fallbackConcurrency: document.getElementById("fallbackConcurrency"),
    timeoutMs: document.getElementById("timeoutMs"),
    delayMs: document.getElementById("delayMs"),
    enableFallback: document.getElementById("enableFallback"),
    startButton: document.getElementById("startButton"),
    stopButton: document.getElementById("stopButton"),
    statsGrid: document.getElementById("statsGrid"),
    resultsBody: document.getElementById("resultsBody"),
    logList: document.getElementById("logList")
  };
}

function bindActions(state, elements) {
  elements.refreshCookieButton?.addEventListener("click", () => refreshCookie(elements));
  elements.startButton?.addEventListener("click", () => startTask(state, elements));
  elements.stopButton?.addEventListener("click", () => stopTask(state, elements));
}

async function refreshHealth(elements) {
  try {
    const [health, cookie] = await Promise.all([
      fetchJson("/api/health"),
      fetchJson("/api/cookie/status").catch(() => null)
    ]);

    elements.serviceStatus.textContent = `服务：${health.status || "正常"}`;
    const cookieInfo = cookie || health.cookie || {};
    renderCookieStatus(elements, cookieInfo);
  } catch (error) {
    elements.serviceStatus.textContent = "服务：异常";
    appendLog(elements.logList, "错误", error.message);
  }
}

async function refreshCookie(elements) {
  if (elements.refreshCookieButton) {
    elements.refreshCookieButton.disabled = true;
  }
  elements.cookieStatus.textContent = "Cookie：刷新中";

  try {
    const data = await fetchJson("/api/cookie/refresh", { method: "POST" });
    renderCookieStatus(elements, data.cookie || {});
    appendLog(elements.logList, "信息", "已刷新无登录游客 Cookie。");
  } catch (error) {
    appendLog(elements.logList, "错误", error.message);
    await refreshHealth(elements);
  } finally {
    if (elements.refreshCookieButton) {
      elements.refreshCookieButton.disabled = false;
    }
  }
}

function renderCookieStatus(elements, cookieInfo = {}) {
  const summary = cookieInfo.summary || (cookieInfo.exists ? "已配置" : "未配置");
  const refreshedAt = formatCookieRefreshTime(cookieInfo.refreshedAt);
  elements.cookieStatus.textContent = refreshedAt
    ? `Cookie：${summary}，${refreshedAt}`
    : `Cookie：${summary}`;
}

async function startTask(state, elements) {
  const file = elements.fileInput.files?.[0];
  if (!file) {
    appendLog(elements.logList, "警告", "请先选择 Excel 文件。");
    return;
  }

  setBusy(elements, true);
  appendLog(elements.logList, "信息", `已选择文件：${file.name}`);

  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("options", JSON.stringify(readOptions(elements)));

    const task = await fetchJson("/api/tasks", {
      method: "POST",
      body: formData
    });

    state.taskId = task.id || "";
    updateTaskView(state, elements, task);
    startPolling(state, elements);
  } catch (error) {
    setBusy(elements, false);
    appendLog(elements.logList, "错误", error.message);
  }
}

async function stopTask(state, elements) {
  if (!state.taskId) {
    return;
  }

  elements.stopButton.disabled = true;
  elements.taskStatus.textContent = "任务：停止中";
  appendLog(elements.logList, "警告", "已请求停止任务。");

  try {
    const task = await fetchJson(`/api/tasks/${encodeURIComponent(state.taskId)}/stop`, {
      method: "POST"
    });
    updateTaskView(state, elements, task);
  } catch (error) {
    recoverStopButtonAfterFailure(state, elements);
    appendLog(elements.logList, "错误", error.message);
  }
}

function startPolling(state, elements) {
  if (state.polling) {
    window.clearInterval(state.polling);
  }

  state.polling = window.setInterval(() => pollTask(state, elements), 2000);
  pollTask(state, elements);
}

async function pollTask(state, elements) {
  if (!state.taskId) {
    return;
  }

  try {
    const task = await fetchJson(`/api/tasks/${encodeURIComponent(state.taskId)}`);
    updateTaskView(state, elements, task);
    await refreshResults(state, elements);

    if (["已完成", "已停止", "失败"].includes(task.status)) {
      stopPolling(state);
      setBusy(elements, false);
    }
  } catch (error) {
    appendLog(elements.logList, "错误", error.message);
  }
}

async function refreshResults(state, elements) {
  const query = buildQuery({ page: state.page, pageSize: state.pageSize });
  const data = await fetchJson(`/api/tasks/${encodeURIComponent(state.taskId)}/results?${query}`);
  renderResults(elements.resultsBody, data.results || []);
}

function updateTaskView(state, elements, task) {
  state.currentTask = task;
  elements.taskStatus.textContent = `任务：${formatTaskStatus(task)}`;
  renderStats(elements.statsGrid, task.stats || task.progress || {});
  renderLog(elements.logList, task.logs || []);

  if (state.taskId) {
    elements.exportLink.href = `/api/tasks/${encodeURIComponent(state.taskId)}/export`;
    elements.exportLink.setAttribute("aria-disabled", "false");
  }
}

function readOptions(elements) {
  return {
    apiConcurrency: readNumber(elements.apiConcurrency, 5),
    apiSeedUrl: readString(elements.apiSeedUrl),
    fallbackConcurrency: readNumber(elements.fallbackConcurrency, 2),
    timeoutMs: readNumber(elements.timeoutMs, 15000),
    delayMs: readNumber(elements.delayMs, 1000),
    enableFallback: Boolean(elements.enableFallback.checked)
  };
}

function readString(input) {
  return String(input?.value || "").trim();
}

function readNumber(input, fallback) {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function renderStats(container, stats) {
  container.innerHTML = STAT_ITEMS.map(([key, label]) => `
    <div class="stat-item">
      <span>${label}</span>
      <strong>${Number(stats[key] || 0)}</strong>
    </div>
  `).join("");
}

function renderResults(tbody, results) {
  if (!results.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">暂无结果</td></tr>';
    return;
  }

  tbody.innerHTML = results.map((item) => `
    <tr>
      <td>${escapeHtml(item.rowNumber ?? "")}</td>
      <td title="${escapeHtml(item.originalUrl || item.url || "")}">${escapeHtml(item.originalUrl || item.url || "")}</td>
      <td>${escapeHtml(item.status || "")}</td>
      <td>${escapeHtml(item.contentType || "")}</td>
      <td title="${escapeHtml(item.finalUrl || "")}">${escapeHtml(item.finalUrl || "")}</td>
      <td title="${escapeHtml(item.remark || item.error || "")}">${escapeHtml(item.remark || item.error || "")}</td>
      <td>${escapeHtml(item.basis || "")}</td>
    </tr>
  `).join("");
}

function renderLog(container, logs) {
  if (!logs.length) {
    container.innerHTML = '<p class="empty-log">暂无日志</p>';
    return;
  }

  container.innerHTML = logs.map((log) => `
    <div class="log-entry">
      <span>${escapeHtml(formatLogTime(log.time))}</span>
      <strong>${escapeHtml(log.level || "信息")}</strong>
      <p>${escapeHtml(log.message || "")}</p>
    </div>
  `).join("");
}

function appendLog(container, level, message) {
  const current = container.querySelector(".empty-log");
  if (current) {
    container.innerHTML = "";
  }
  const item = document.createElement("div");
  item.className = "log-entry";
  item.innerHTML = `
    <span>${escapeHtml(formatLogTime(new Date().toISOString()))}</span>
    <strong>${escapeHtml(level)}</strong>
    <p>${escapeHtml(message)}</p>
  `;
  container.prepend(item);
}

function setBusy(elements, busy) {
  elements.startButton.disabled = busy;
  elements.stopButton.disabled = !busy;
}

function stopPolling(state) {
  if (state.polling) {
    window.clearInterval(state.polling);
    state.polling = null;
  }
}

function parseJsonOrNull(text) {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRunningTask(task) {
  return ["等待中", "检测中", "停止中"].includes(task?.status);
}

function formatLogTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatCookieRefreshTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `刷新 ${date.toLocaleString("zh-CN", { hour12: false })}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
