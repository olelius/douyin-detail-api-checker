import fs from "node:fs";
import { chromium } from "playwright";
import {
  BROWSER_USER_AGENT,
  DEFAULT_OPTIONS,
  DETAIL_API_KEYWORDS,
  SYSTEM_BROWSER_PATHS
} from "./config.js";
import { hasDetailWorkCandidate } from "./classifier.js";

export function createDetailDetector(options = {}) {
  const config = {
    ...DEFAULT_OPTIONS,
    ...options
  };

  let browserPromise = null;

  async function getBrowser() {
    if (!browserPromise) {
      browserPromise = launchBrowser(config);
    }
    return browserPromise;
  }

  return {
    config,
    async detect(url) {
      if (!url || typeof url !== "string") {
        throw new TypeError("待检测链接必须是非空字符串。");
      }

      const startedAt = new Date();
      const result = {
        originalUrl: url,
        finalUrl: url,
        apiUrl: "",
        detailJson: null,
        fallbackText: "",
        error: "",
        apiParseErrors: [],
        debugMessages: [],
        timedOut: false,
        startedAt,
        finishedAt: null
      };

      let context;
      let page;

      try {
        const browser = await getBrowser();
        context = await browser.newContext({
          userAgent: BROWSER_USER_AGENT,
          locale: "zh-CN",
          timezoneId: "Asia/Shanghai",
          viewport: { width: 1365, height: 768 }
        });
        page = await context.newPage();

        page.on("response", async (response) => {
          const responseUrl = response.url();
          if (result.detailJson) {
            return;
          }

          const contentType = response.headers()["content-type"] || "";
          if (!contentType.toLowerCase().includes("json")) {
            return;
          }

          try {
            const json = await response.json();
            if (!shouldCaptureDetailResponseJson(responseUrl, json)) {
              return;
            }
            result.apiUrl = responseUrl;
            result.detailJson = json;
          } catch (error) {
            recordApiParseError(result, responseUrl, error);
          }
        });

        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
        } catch (error) {
          result.timedOut = error.name === "TimeoutError";
          result.error = result.timedOut ? `页面打开超时：${config.timeoutMs}ms` : `页面打开失败：${error.message}`;
        }

        await page.waitForTimeout(config.waitAfterLoadMs);
        result.finalUrl = page.url();
        result.fallbackText = await readBodyText(page);
      } catch (error) {
        result.error = result.error || `浏览器检测失败：${error.message}`;
      } finally {
        result.finishedAt = new Date();
        await safeClose(page);
        await safeClose(context);
      }

      return result;
    },
    async close() {
      if (!browserPromise) {
        return;
      }
      const browser = await browserPromise.catch(() => null);
      browserPromise = null;
      await safeClose(browser);
    }
  };
}

export function createFallbackDetector(options = {}) {
  const detector = options.detailDetector || options.detector || createDetailDetector(options);

  return {
    async detect(row) {
      const url = typeof row === "string" ? row : row?.url;
      const evidence = await detector.detect(url);
      return {
        ...evidence,
        rowNumber: typeof row === "string" ? evidence.rowNumber : row?.rowNumber ?? evidence.rowNumber,
        stage: "fallback",
        needsFallback: false
      };
    },
    async close() {
      if (typeof detector.close === "function") {
        await detector.close();
      }
    }
  };
}

export function findSystemBrowserPath(paths = SYSTEM_BROWSER_PATHS) {
  return paths.find((browserPath) => fs.existsSync(browserPath)) || "";
}

export function isDetailApiUrl(url) {
  const lowerUrl = String(url || "").toLowerCase();
  return DETAIL_API_KEYWORDS.some((keyword) => lowerUrl.includes(keyword.toLowerCase()));
}

export function shouldCaptureDetailResponseJson(url, json) {
  return isDetailApiUrl(url) || hasDetailWorkCandidate(json);
}

export function recordApiParseError(result, responseUrl, error) {
  if (!result || typeof result !== "object") {
    return;
  }

  const message = `候选 JSON 响应解析失败：${error?.message || "未知错误"}`;

  if (!Array.isArray(result.apiParseErrors)) {
    result.apiParseErrors = [];
  }
  result.apiParseErrors.push({
    url: responseUrl,
    message
  });

  if (!Array.isArray(result.debugMessages)) {
    result.debugMessages = [];
  }
  result.debugMessages.push(`[detail-api][non-fatal] ${responseUrl} ${message}`);
}

async function launchBrowser(config) {
  const executablePath = config.executablePath || findSystemBrowserPath();
  if (!executablePath) {
    throw new Error("未找到系统 Chrome/Edge，请安装 Chrome/Edge，或先执行 Playwright 浏览器安装。");
  }

  return chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--lang=zh-CN",
      "--no-first-run",
      "--disable-dev-shm-usage"
    ]
  });
}

async function readBodyText(page) {
  try {
    return await page.evaluate(() => document.body?.innerText || "");
  } catch (error) {
    return `读取 DOM 文本失败：${error.message}`;
  }
}

async function safeClose(target) {
  if (!target || typeof target.close !== "function") {
    return;
  }

  try {
    await target.close();
  } catch {
    // 关闭失败不影响检测结果，主错误已在 result.error 中记录。
  }
}
