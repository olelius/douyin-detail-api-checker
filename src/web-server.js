import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { readInputWorkbook } from "./excel.js";

const DEFAULT_VERSION = "0.1.0";
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 50 * 1024 * 1024;
const EXCEL_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const EXPORT_ERROR_MESSAGE = "导出 Excel 失败，请确认输出文件未被占用后重试。";
const SENSITIVE_KEY_PATTERN = /^(storagePath|cookieHeader|set-cookie|sessionid|sid_guard|uid_tt|ttwid|passport_csrf_token|msToken|odin_tt|__ac_nonce|__ac_signature)$/i;
const SENSITIVE_VALUE_PATTERN = /\b(sessionid|sid_guard|uid_tt|ttwid|passport_csrf_token|msToken|odin_tt|__ac_nonce|__ac_signature)\s*=\s*[^;\s,"]+/gi;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /[A-Za-z]:\\[^\s"'<>]+/g;
const POSIX_ABSOLUTE_PATH_PATTERN = /\/(?:[^\s"'<>/]+\/)+[^\s"'<>]+/g;

export function createWebServer(deps = {}) {
  const webRoot = path.resolve(deps.webRoot || path.join(process.cwd(), "web"));
  const outputRoot = path.resolve(deps.outputRoot || path.join(process.cwd(), "output"));
  const uploadRoot = path.resolve(deps.uploadRoot || path.join(process.cwd(), "uploads"));

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (url.pathname.startsWith("/api/")) {
        return await handleApiRequest(req, res, url, deps, outputRoot, uploadRoot);
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        return sendJson(res, 405, { error: "请求方法不支持。" });
      }

      return await sendStatic(req, res, url, webRoot);
    } catch (error) {
      recordServerError(deps, "服务处理失败", error);
      return sendJson(res, 500, { error: "服务处理失败，请查看本地日志。" });
    }
  });
}

export function sendJson(res, statusCode, data, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(sanitizeResponseData(data)));
}

async function handleApiRequest(req, res, url, deps, outputRoot, uploadRoot) {
  const allowedMethods = getAllowedApiMethods(url.pathname);
  if (allowedMethods && !allowedMethods.includes(req.method || "")) {
    return sendMethodNotAllowed(res, allowedMethods);
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    const cookie = deps.cookieStore?.getStatus
      ? await deps.cookieStore.getStatus()
      : { exists: false, summary: "未配置 Cookie 存储" };
    return sendJson(res, 200, {
      status: "正常",
      host: req.socket.localAddress || "127.0.0.1",
      port: req.socket.localPort,
      version: deps.version || DEFAULT_VERSION,
      cookie
    });
  }

  if (req.method === "GET" && url.pathname === "/api/cookie/status") {
    if (!deps.cookieStore?.getStatus) {
      return sendJson(res, 200, { exists: false, summary: "未配置 Cookie 存储" });
    }
    return sendJson(res, 200, await deps.cookieStore.getStatus());
  }

  if (req.method === "POST" && url.pathname === "/api/cookie/refresh") {
    if (!deps.cookieRefresher?.refresh) {
      return sendJson(res, 503, { error: "Cookie 刷新器未接入，无法刷新游客 Cookie。" });
    }

    let payload = {};
    try {
      payload = await readOptionalJsonBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: sanitizeText(error.message) });
    }

    try {
      const status = await deps.cookieRefresher.refresh(payload.targetUrl || payload.url || "");
      return sendJson(res, 200, {
        status: "已刷新",
        message: "已保存无登录游客 Cookie。",
        cookie: status || (deps.cookieStore?.getStatus ? await deps.cookieStore.getStatus() : {})
      });
    } catch (error) {
      recordServerError(deps, "Cookie 刷新失败", error);
      return sendJson(res, 500, {
        status: "刷新失败",
        error: `Cookie 刷新失败：${sanitizeText(error?.message || error)}`
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    if (!deps.taskManager?.createTask) {
      return sendJson(res, 501, { error: "任务管理器未接入。" });
    }

    let payload;
    try {
      payload = isMultipartFormData(req.headers["content-type"])
        ? await readMultipartTaskPayload(req, uploadRoot, outputRoot)
        : await readJsonBody(req);
    } catch (error) {
      if (error?.statusCode) {
        return sendJson(res, error.statusCode, { error: sanitizeText(error.message) });
      }
      throw error;
    }

    if (!hasDetectRows(payload)) {
      return sendJson(res, 400, { error: "请提供待检测链接 rows，或上传包含抖音链接的 Excel 文件。" });
    }
    payload.options = normalizeTaskOptions(payload.options);
    const task = await deps.taskManager.createTask(payload);
    startTaskInBackground(deps, task.id);
    return sendJson(res, 201, task);
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/(?<id>[^/]+)$/);
  if (req.method === "GET" && taskMatch) {
    return withTaskErrorMapping(res, () => {
      const task = deps.taskManager?.getTask?.(taskMatch.groups.id);
      if (!task) {
        throw new Error("任务不存在。");
      }
      return sendJson(res, 200, task);
    });
  }

  const taskResultsMatch = url.pathname.match(/^\/api\/tasks\/(?<id>[^/]+)\/results$/);
  if (req.method === "GET" && taskResultsMatch) {
    return withTaskErrorMapping(res, () => {
      const results = deps.taskManager?.getTaskResults?.(taskResultsMatch.groups.id, {
        page: url.searchParams.get("page"),
        pageSize: url.searchParams.get("pageSize")
      });
      if (!results) {
        throw new Error("任务结果接口未接入。");
      }
      return sendJson(res, 200, results);
    });
  }

  const taskExportMatch = url.pathname.match(/^\/api\/tasks\/(?<id>[^/]+)\/export$/);
  if (req.method === "GET" && taskExportMatch) {
    return exportTaskWorkbookResponse(res, deps, outputRoot, taskExportMatch.groups.id);
  }

  const taskStopMatch = url.pathname.match(/^\/api\/tasks\/(?<id>[^/]+)\/stop$/);
  if (req.method === "POST" && taskStopMatch) {
    return withTaskErrorMapping(res, () => {
      const task = deps.taskManager?.stopTask?.(taskStopMatch.groups.id);
      if (!task) {
        throw new Error("任务停止接口未接入。");
      }
      return sendJson(res, 200, task);
    });
  }

  return sendJson(res, 404, { error: "接口不存在。" });
}

function hasDetectRows(payload) {
  return Array.isArray(payload?.rows) && payload.rows.some((row) => typeof row?.url === "string" && row.url.trim());
}

function toDetectRows(rows = []) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map((row) => ({
    rowNumber: row?.rowNumber,
    url: typeof row?.url === "string" ? row.url : ""
  }));
}

async function readMultipartTaskPayload(req, uploadRoot, outputRoot) {
  const form = await readMultipartFormData(req);
  const file = form.files.find((item) => item.name === "file") || form.files[0];

  if (!file || file.data.length === 0) {
    throw createHttpError(400, "请上传 Excel 文件。");
  }
  if (file.filename && path.extname(file.filename).toLowerCase() !== ".xlsx") {
    throw createHttpError(400, "仅支持上传 .xlsx Excel 文件。");
  }

  const inputPath = await saveUploadedExcel(uploadRoot, file);
  let inputData;
  try {
    inputData = await readInputWorkbook(inputPath);
  } catch (error) {
    throw createHttpError(400, `Excel 解析失败：${sanitizeText(error?.message || error)}`);
  }

  return {
    inputPath,
    outputPath: buildUploadOutputPath(outputRoot),
    inputFileName: sanitizeUploadedFilename(file.filename),
    inputData,
    rows: toDetectRows(inputData.rows),
    options: parseTaskOptions(form.fields)
  };
}

async function saveUploadedExcel(uploadRoot, file) {
  await fs.mkdir(uploadRoot, { recursive: true });
  const filePath = path.resolve(uploadRoot, `${Date.now()}-${randomUUID()}.xlsx`);
  ensureUploadPathAllowed(uploadRoot, filePath);
  await fs.writeFile(filePath, file.data);
  return filePath;
}

function buildUploadOutputPath(outputRoot) {
  return path.resolve(outputRoot, `检测结果-${Date.now()}-${randomUUID()}.xlsx`);
}

function parseTaskOptions(fields = {}) {
  const options = parseJsonObjectField(fields.options);
  const numericKeys = ["apiConcurrency", "fallbackConcurrency", "timeoutMs", "delayMs"];

  for (const key of numericKeys) {
    if (fields[key] !== undefined) {
      const value = Number(fields[key]);
      if (Number.isFinite(value)) {
        options[key] = value;
      }
    }
  }

  if (fields.enableFallback !== undefined) {
    options.enableFallback = ["1", "true", "on", "yes"].includes(String(fields.enableFallback).toLowerCase());
  }

  if (fields.apiSeedUrl !== undefined) {
    options.apiSeedUrl = fields.apiSeedUrl;
  }

  return normalizeTaskOptions(options);
}

function normalizeTaskOptions(options = {}) {
  const normalized = options && typeof options === "object" && !Array.isArray(options)
    ? { ...options }
    : {};

  if (Object.hasOwn(normalized, "apiSeedUrl")) {
    normalized.apiSeedUrl = typeof normalized.apiSeedUrl === "string"
      ? normalized.apiSeedUrl.trim()
      : "";
  }

  return normalized;
}

function parseJsonObjectField(value) {
  if (value === undefined || value === "") {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw createHttpError(400, "任务参数格式无效。");
  }
}

async function readMultipartFormData(req) {
  const boundary = parseMultipartBoundary(req.headers["content-type"]);
  if (!boundary) {
    throw createHttpError(400, "上传请求缺少 multipart 边界。");
  }

  const body = await readRequestBuffer(req, MAX_UPLOAD_BODY_BYTES);
  return parseMultipartBody(body, boundary);
}

function parseMultipartBoundary(contentType = "") {
  const match = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? (match[1] || match[2] || "").trim() : "";
}

function parseMultipartBody(body, boundary) {
  const marker = `--${boundary}`;
  const text = body.toString("latin1");
  const sections = text.split(marker).slice(1, -1);
  const fields = {};
  const files = [];

  for (const section of sections) {
    const part = trimMultipartSection(section);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      continue;
    }

    const headers = parsePartHeaders(part.slice(0, headerEnd));
    const disposition = headers["content-disposition"] || "";
    const name = getDispositionParam(disposition, "name");
    if (!name) {
      continue;
    }

    const data = Buffer.from(part.slice(headerEnd + 4), "latin1");
    const filename = getDispositionParam(disposition, "filename");
    if (filename !== "") {
      files.push({ name, filename, data, contentType: headers["content-type"] || "" });
    } else {
      fields[name] = data.toString("utf8");
    }
  }

  return { fields, files };
}

function trimMultipartSection(section) {
  let value = section;
  if (value.startsWith("\r\n")) {
    value = value.slice(2);
  }
  if (value.endsWith("\r\n")) {
    value = value.slice(0, -2);
  }
  return value;
}

function parsePartHeaders(headerText) {
  const headers = {};
  for (const line of headerText.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function getDispositionParam(disposition, key) {
  const quoted = new RegExp(`${key}="([^"]*)"`, "i").exec(disposition);
  if (quoted) {
    return quoted[1];
  }
  const bare = new RegExp(`${key}=([^;]+)`, "i").exec(disposition);
  return bare ? bare[1].trim() : "";
}

function readRequestBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(createHttpError(413, "上传文件过大。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function isMultipartFormData(contentType = "") {
  return /^multipart\/form-data\b/i.test(String(contentType));
}

function sanitizeUploadedFilename(filename = "") {
  return path.basename(String(filename || "")).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

function ensureUploadPathAllowed(uploadRoot, filePath) {
  const resolvedUploadPath = path.resolve(filePath);
  if (!isInsideDirectory(uploadRoot, resolvedUploadPath)) {
    throw createHttpError(400, "上传路径必须位于 uploads 目录下。");
  }
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function startTaskInBackground(deps, taskId) {
  if (typeof deps.taskManager?.startTask !== "function") {
    return;
  }

  Promise.resolve()
    .then(() => deps.taskManager.startTask(taskId))
    .catch((error) => {
      recordServerError(deps, "任务启动失败", error);
    });
}

function getAllowedApiMethods(pathname) {
  if (pathname === "/api/health") {
    return ["GET"];
  }
  if (pathname === "/api/cookie/status") {
    return ["GET"];
  }
  if (pathname === "/api/cookie/refresh") {
    return ["POST"];
  }
  if (pathname === "/api/tasks") {
    return ["POST"];
  }
  if (/^\/api\/tasks\/[^/]+$/.test(pathname)) {
    return ["GET"];
  }
  if (/^\/api\/tasks\/[^/]+\/results$/.test(pathname)) {
    return ["GET"];
  }
  if (/^\/api\/tasks\/[^/]+\/export$/.test(pathname)) {
    return ["GET"];
  }
  if (/^\/api\/tasks\/[^/]+\/stop$/.test(pathname)) {
    return ["POST"];
  }
  return null;
}

function sendMethodNotAllowed(res, allowedMethods) {
  return sendJson(res, 405, { error: "请求方法不支持。" }, {
    allow: allowedMethods.join(", ")
  });
}

async function sendStatic(req, res, url, webRoot) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: "静态资源路径编码无效。" });
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(webRoot, relativePath);
  if (!isInsideDirectory(webRoot, filePath)) {
    return sendJson(res, 403, { error: "不允许访问 web 目录外的静态资源。" });
  }

  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "cache-control": "no-store"
    });
    if (req.method === "HEAD") {
      return res.end();
    }
    return res.end(body);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") {
      return sendJson(res, 404, { error: "静态资源不存在。" });
    }
    throw error;
  }
}

function withTaskErrorMapping(res, handler) {
  try {
    return handler();
  } catch (error) {
    if (String(error?.message || "").includes("不存在")) {
      return sendJson(res, 404, { error: sanitizeText(error.message) });
    }
    return sendJson(res, 500, { error: "任务接口处理失败，请查看本地日志。" });
  }
}

async function exportTaskWorkbookResponse(res, deps, outputRoot, taskId) {
  try {
    if (!deps.taskManager?.getTaskExportPayload || !deps.exportTaskWorkbook) {
      return sendJson(res, 501, { error: "任务导出接口未接入。" });
    }

    const payload = deps.taskManager.getTaskExportPayload(taskId);
    ensureOutputPathAllowed(outputRoot, payload.outputPath);
    const exported = await deps.exportTaskWorkbook(payload);
    ensureOutputPathAllowed(outputRoot, exported.outputPath);
    const readExportFile = deps.readExportFile || fs.readFile;
    const body = await readExportFile(exported.outputPath);

    res.writeHead(200, {
      "content-type": EXCEL_CONTENT_TYPE,
      "content-disposition": "attachment; filename*=UTF-8''%E6%A3%80%E6%B5%8B%E7%BB%93%E6%9E%9C.xlsx",
      "cache-control": "no-store"
    });
    return res.end(body);
  } catch (error) {
    recordServerError(deps, "导出 Excel 失败", error);
    return sendJson(res, 500, { error: EXPORT_ERROR_MESSAGE });
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk, "utf8");
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error("请求体过大。"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("请求 JSON 格式无效。"));
      }
    });
    req.on("error", reject);
  });
}

async function readOptionalJsonBody(req) {
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType) {
    return {};
  }
  if (!/^application\/json\b/i.test(contentType)) {
    return {};
  }
  return readJsonBody(req);
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml; charset=utf-8"
  };
  return types[extension] || "application/octet-stream";
}

function isInsideDirectory(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureOutputPathAllowed(outputRoot, outputPath) {
  if (!outputPath || typeof outputPath !== "string") {
    throw new Error("导出路径无效。");
  }
  const resolvedOutputPath = path.resolve(outputPath);
  if (!isInsideDirectory(outputRoot, resolvedOutputPath)) {
    throw new Error("导出路径必须位于 output 目录下。");
  }
}

function sanitizeResponseData(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeResponseData(item));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        continue;
      }
      result[key] = sanitizeResponseData(item);
    }
    return result;
  }
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  return value;
}

function sanitizeText(text) {
  return String(text || "").replace(SENSITIVE_VALUE_PATTERN, "$1=***");
}

function recordServerError(deps, context, error) {
  const message = sanitizeInternalDetail(error?.stack || error?.message || error);
  if (typeof deps.logger?.error === "function") {
    deps.logger.error({ context, message });
  }
}

function sanitizeInternalDetail(text) {
  return sanitizeText(text)
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, "[本地路径]")
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, "[本地路径]");
}
