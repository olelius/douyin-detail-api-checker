import { chromium } from "playwright";
import { BROWSER_USER_AGENT, DEFAULT_API_OPTIONS } from "./config.js";
import { findSystemBrowserPath } from "./detector.js";
import { maskCookieSummary, normalizeCookies } from "./cookie-store.js";

const DEFAULT_TARGET_URL = "https://www.douyin.com/";
const DEFAULT_WAIT_AFTER_LOAD_MS = 2500;

export function createGuestCookieRefresher(options = {}) {
  const cookieStore = options.cookieStore;
  const timeoutMs = options.timeoutMs || DEFAULT_API_OPTIONS.timeoutMs;
  const waitAfterLoadMs = options.waitAfterLoadMs ?? DEFAULT_WAIT_AFTER_LOAD_MS;
  const targetUrl = options.targetUrl || DEFAULT_TARGET_URL;
  const launchBrowser = options.launchBrowser || ((config) => launchDefaultBrowser(config));
  let refreshPromise = null;

  return {
    async refresh(publicUrl) {
      if (refreshPromise) {
        return refreshPromise;
      }

      refreshPromise = runGuestCookieRefresh({
        cookieStore,
        launchBrowser,
        targetUrl: normalizePublicDouyinUrl(publicUrl) || targetUrl,
        timeoutMs,
        waitAfterLoadMs
      }).finally(() => {
        refreshPromise = null;
      });

      return refreshPromise;
    }
  };
}

export function sanitizeCookieRefreshError(error) {
  return String(error?.message || error || "未知错误").replace(
    /\b(sessionid|ttwid|sid_guard|uid_tt|passport_csrf_token|msToken|odin_tt|__ac_nonce|__ac_signature)\s*=\s*[^;\s,"]+/gi,
    "$1=***"
  );
}

async function runGuestCookieRefresh({ cookieStore, launchBrowser, targetUrl, timeoutMs, waitAfterLoadMs }) {
  if (!cookieStore || typeof cookieStore.saveCookieHeader !== "function") {
    throw new Error("Cookie 存储未接入，无法刷新游客 Cookie。");
  }

  let browser;
  let context;
  let page;
  let navigationError = null;

  try {
    browser = await launchBrowser({ timeoutMs });
    context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1365, height: 768 }
    });
    page = await context.newPage();

    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch (error) {
      navigationError = error;
    }

    if (waitAfterLoadMs > 0 && typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(waitAfterLoadMs);
    }

    const cookies = await context.cookies([DEFAULT_TARGET_URL]);
    const cookieHeader = normalizeCookies(cookies);
    if (!cookieHeader) {
      const suffix = navigationError ? `，页面打开提示：${sanitizeCookieRefreshError(navigationError)}` : "";
      throw new Error(`未采集到抖音游客 Cookie${suffix}`);
    }

    await cookieStore.saveCookieHeader(cookieHeader);
    if (typeof cookieStore.getStatus === "function") {
      return cookieStore.getStatus();
    }
    return {
      exists: true,
      summary: maskCookieSummary(cookieHeader),
      refreshedAt: new Date().toISOString()
    };
  } finally {
    await safeClose(page);
    await safeClose(context);
    await safeClose(browser);
  }
}

async function launchDefaultBrowser({ timeoutMs }) {
  const executablePath = findSystemBrowserPath();
  if (!executablePath) {
    throw new Error("未找到系统 Chrome/Edge，无法采集无登录游客 Cookie。");
  }

  return chromium.launch({
    headless: true,
    executablePath,
    timeout: timeoutMs,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--lang=zh-CN",
      "--no-first-run",
      "--disable-dev-shm-usage"
    ]
  });
}

function normalizePublicDouyinUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  try {
    const url = new URL(text);
    return url.hostname.endsWith("douyin.com") ? url.href : "";
  } catch {
    return "";
  }
}

async function safeClose(target) {
  if (!target || typeof target.close !== "function") {
    return;
  }

  try {
    await target.close();
  } catch {
    // 关闭失败不影响 Cookie 刷新主结果。
  }
}
