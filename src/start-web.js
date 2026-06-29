import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { classifyDetailResult } from "./classifier.js";
import { createApiDetector } from "./api-detector.js";
import { DEFAULT_API_OPTIONS, DEFAULT_FALLBACK_OPTIONS, getUiServiceConfig } from "./config.js";
import { createApiProfileCache } from "./api-profile-cache.js";
import { createGuestCookieRefresher, sanitizeCookieRefreshError } from "./cookie-refresher.js";
import { createCookieStore } from "./cookie-store.js";
import { createFallbackDetector } from "./detector.js";
import { exportTaskWorkbook } from "./excel.js";
import { createTaskManager } from "./task-manager.js";
import { createWebServer } from "./web-server.js";

const DEFAULT_VERSION = "0.1.0";

export function createDefaultWebDeps(options = {}) {
  const cookieStore = options.cookieStore || createCookieStore();
  const cookieRefresher = options.cookieRefresher || createGuestCookieRefresher({
    cookieStore,
    ...(options.cookieRefreshOptions || {})
  });
  const createApiDetectorImpl = options.createApiDetector || createApiDetector;
  const createFallbackDetectorImpl = options.createFallbackDetector || createFallbackDetector;
  const apiProfileCache = options.apiProfileCache === false
    ? null
    : options.apiProfileCache || createApiProfileCache(options.apiProfileOptions || {});
  const fallbackDetector = options.fallbackDetector || createFallbackDetectorImpl(options.fallbackOptions || {});
  const apiDetector = options.apiDetector || createWebApiDetector({
    cookieStore,
    cookieRefresher,
    createApiDetector: createApiDetectorImpl,
    apiProfileCache,
    apiOptions: options.apiOptions || {}
  });
  const taskManager = options.taskManager || createTaskManager({
    apiDetector,
    fallbackDetector,
    apiProfileCache,
    classifyDetailResult
  });

  return {
    version: options.version || DEFAULT_VERSION,
    cookieStore,
    cookieRefresher,
    apiProfileCache,
    taskManager,
    exportTaskWorkbook: options.exportTaskWorkbook || exportTaskWorkbook,
    async close() {
      if (typeof fallbackDetector.close === "function") {
        await fallbackDetector.close();
      }
      if (typeof apiDetector.close === "function") {
        await apiDetector.close();
      }
    }
  };
}

export function startWebService(options = {}) {
  const config = options.config || getUiServiceConfig(options.env);
  const deps = options.deps || createDefaultWebDeps(options);
  const server = options.server || createWebServer(deps);
  const openBrowser = options.openBrowser ?? config.openBrowser;

  server.listen(config.port, config.host, () => {
    const url = `http://localhost:${config.port}`;
    console.log(`本地 Web UI 服务已启动：${url}`);
    console.log(`API 快筛默认并发：${DEFAULT_API_OPTIONS.concurrency}，Playwright 兜底默认并发：${DEFAULT_FALLBACK_OPTIONS.concurrency}`);
    if (openBrowser) {
      openLocalBrowser(url, options.execFileImpl || execFile);
    }
  });

  server.on("error", (error) => {
    console.error(formatStartupError(error, config.port));
    process.exitCode = 1;
  });
  server.on("close", () => {
    Promise.resolve(deps.close?.()).catch((error) => {
      console.error(`Web 资源关闭失败：${error?.message || error}`);
    });
  });

  return server;
}

function createWebApiDetector({ cookieStore, cookieRefresher, createApiDetector: createApiDetectorImpl, apiProfileCache, apiOptions }) {
  return {
    async detect(url, runtime = {}) {
      let cookieHeader = "";
      try {
        cookieHeader = typeof cookieStore.getCookieHeader === "function"
          ? await cookieStore.getCookieHeader()
          : "";
      } catch (error) {
        return {
          stage: "api",
          originalUrl: url,
          finalUrl: url,
          detailJson: null,
          needsFallback: true,
          errorType: "request_error",
          error: `Cookie 读取失败，已转入 Playwright 兜底：${error?.message || error}`
        };
      }

      if (!cookieHeader) {
        const refreshResult = await refreshGuestCookieForApi(cookieRefresher, cookieStore, url);
        if (!refreshResult.ok) {
          return buildCookieRefreshFallback(url, refreshResult.error);
        }
        cookieHeader = refreshResult.cookieHeader;
      }

      const firstEvidence = await runApiDetector({
        createApiDetectorImpl,
        apiOptions,
        runtime,
        apiProfileCache,
        cookieHeader,
        url
      });

      if (!shouldRefreshAndRetry(firstEvidence)) {
        return firstEvidence;
      }

      const refreshResult = await refreshGuestCookieForApi(cookieRefresher, cookieStore, url);
      if (!refreshResult.ok) {
        return {
          ...firstEvidence,
          needsFallback: true,
          errorType: firstEvidence.errorType || "cookie_refresh_failed",
          error: appendSafeError(firstEvidence.error, `Cookie 刷新失败：${refreshResult.error}`)
        };
      }

      return runApiDetector({
        createApiDetectorImpl,
        apiOptions,
        runtime,
        apiProfileCache,
        cookieHeader: refreshResult.cookieHeader,
        url
      });
    }
  };
}

async function runApiDetector({ createApiDetectorImpl, apiOptions, runtime, apiProfileCache, cookieHeader, url }) {
  const detector = createApiDetectorImpl({
        ...apiOptions,
        ...runtime.options,
        apiProfileCache,
        apiProfile: apiProfileCache?.getProfile?.() || null,
        cookieHeader
      });
  return detector.detect(url);
}

async function refreshGuestCookieForApi(cookieRefresher, cookieStore, url) {
  if (!cookieRefresher || typeof cookieRefresher.refresh !== "function") {
    return { ok: false, error: "Cookie 刷新器未接入" };
  }

  try {
    await cookieRefresher.refresh(url);
    const cookieHeader = typeof cookieStore.getCookieHeader === "function"
      ? await cookieStore.getCookieHeader()
      : "";
    if (!cookieHeader) {
      return { ok: false, error: "刷新后仍未读取到游客 Cookie" };
    }
    return { ok: true, cookieHeader };
  } catch (error) {
    return { ok: false, error: sanitizeCookieRefreshError(error) };
  }
}

function buildCookieRefreshFallback(url, error) {
  return {
    stage: "api",
    originalUrl: url,
    finalUrl: url,
    detailJson: null,
    needsFallback: true,
    errorType: "cookie_refresh_failed",
    error: `Cookie 刷新失败，已转入 Playwright 兜底：${error}`,
    startedAt: new Date(),
    finishedAt: new Date()
  };
}

function shouldRefreshAndRetry(evidence = {}) {
  if (evidence.needsFallback !== true) {
    return false;
  }
  const text = `${evidence.errorType || ""} ${evidence.error || ""} ${JSON.stringify(evidence.detailJson || {})}`;
  return /risk_control|auth|cookie|登录|验证码|安全验证|访问过于频繁|稍后再试|captcha|verify|401|403/i.test(text);
}

function appendSafeError(primary = "", secondary = "") {
  return [primary, secondary].filter(Boolean).join("；");
}

export function formatStartupError(error, port) {
  if (error?.code === "EADDRINUSE") {
    return `端口 ${port} 已被占用，请释放端口后重新启动。服务不会自动切换端口。`;
  }
  return `本地 Web UI 服务启动失败：${error?.message || error}`;
}

function openLocalBrowser(url, execFileImpl) {
  execFileImpl("cmd", ["/c", "start", "", url], { windowsHide: true }, (error) => {
    if (error) {
      console.error(`浏览器自动打开失败，请手动访问：${url}`);
    }
  });
}

function isDirectRun() {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  startWebService();
}
