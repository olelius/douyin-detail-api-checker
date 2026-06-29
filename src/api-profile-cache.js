import { chromium } from "playwright";
import { BROWSER_USER_AGENT, DETAIL_API_KEYWORDS } from "./config.js";
import { findSystemBrowserPath } from "./detector.js";
import { normalizeCookies } from "./cookie-store.js";

export const DEFAULT_API_PROFILE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_PROFILE_WAIT_AFTER_LOAD_MS = 6000;

const WORK_ID_PARAM_NAMES = new Set(["aweme_id", "item_id", "aweme_ids"]);
const VOLATILE_PARAM_NAMES = new Set([
  "a_bogus",
  "x-secsdk-web-signature",
  "__ac_nonce",
  "__ac_signature",
  "mstoken"
]);
const COOKIE_PARAM_NAMES = [
  "sessionid",
  "ttwid",
  "sid_guard",
  "uid_tt",
  "passport_csrf_token",
  "msToken",
  "odin_tt",
  "__ac_nonce",
  "__ac_signature"
];
const PROFILE_REQUEST_HEADER_ALLOWLIST = new Set([
  "user-agent",
  "accept",
  "accept-language",
  "referer",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "uifid"
]);

export function createApiProfileCache(options = {}) {
  const ttlMs = normalizePositiveNumber(options.ttlMs, DEFAULT_API_PROFILE_TTL_MS);
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const captureProfile = options.captureProfile || ((url) => captureApiProfileFromBrowser(url, options));
  let profile = null;
  let status = { status: "empty" };
  let inFlight = null;

  function hasFreshProfile() {
    return Boolean(profile && profile.status === "ready" && Number(profile.expiresAt) > now());
  }

  async function runWarmup(url) {
    try {
      const captured = await captureProfile(url, { ttlMs, now: now() });
      const nextProfile = typeof captured === "string"
        ? extractApiProfileFromUrl(captured, { capturedAt: now(), ttlMs })
        : normalizeProfile(captured, { capturedAt: now(), ttlMs });

      if (!nextProfile || nextProfile.status !== "ready") {
        throw new Error("未捕获到可复用的 detail API 参数画像。");
      }

      profile = nextProfile;
      status = profile.safeStatus || buildSafeStatus(profile);
      return { ok: true, status: status.status, profile };
    } catch (error) {
      profile = null;
      status = {
        status: "failed",
        error: sanitizeProfileMessage(error?.message || error || "参数画像预热失败")
      };
      return { ok: false, status: "failed", error: status.error };
    } finally {
      inFlight = null;
    }
  }

  return {
    async ensureProfile(url) {
      if (hasFreshProfile()) {
        return { ok: true, status: "ready", profile };
      }
      if (inFlight) {
        return inFlight;
      }
      inFlight = runWarmup(url);
      return inFlight;
    },
    getProfile() {
      return hasFreshProfile() ? profile : null;
    },
    getStatus() {
      if (hasFreshProfile()) {
        return profile.safeStatus || buildSafeStatus(profile);
      }
      return { ...status };
    },
    buildCandidates(info) {
      return buildProfileCandidates(hasFreshProfile() ? profile : null, info);
    },
    clear() {
      profile = null;
      status = { status: "empty" };
      inFlight = null;
    }
  };
}

export function extractApiProfileFromUrl(capturedUrl, options = {}) {
  let url;
  try {
    url = new URL(capturedUrl);
  } catch {
    return buildInvalidProfile("捕获 URL 无法解析", options);
  }

  const endpoint = `${url.origin}${url.pathname}`;
  const queryParams = [];
  const volatileParamNames = [];
  const workIdParamNames = [];

  for (const [name, value] of url.searchParams.entries()) {
    const normalizedName = name.toLowerCase();
    if (WORK_ID_PARAM_NAMES.has(normalizedName)) {
      workIdParamNames.push(name);
      queryParams.push([name, value]);
      continue;
    }
    if (VOLATILE_PARAM_NAMES.has(normalizedName)) {
      volatileParamNames.push(name);
    }
    queryParams.push([name, value]);
  }

  const profile = normalizeProfile({
    status: isReusableDetailEndpoint(endpoint) && workIdParamNames.length > 0 ? "ready" : "invalid",
    endpoint,
    queryParams,
    volatileParamNames: [...new Set(volatileParamNames)],
    workIdParamNames: [...new Set(workIdParamNames)],
    requestHeaders: options.requestHeaders || {},
    cookieHeader: options.cookieHeader || "",
    capturedAt: Number(options.capturedAt ?? Date.now()),
    expiresAt: Number(options.capturedAt ?? Date.now()) + normalizePositiveNumber(options.ttlMs, DEFAULT_API_PROFILE_TTL_MS),
    sourceWorkId: options.sourceWorkId || ""
  }, options);

  return profile.status === "ready"
    ? profile
    : buildInvalidProfile("捕获 URL 缺少可复用 detail endpoint 或作品 ID 参数", options);
}

export function buildProfileCandidates(profile, info = {}) {
  const normalizedProfile = normalizeProfile(profile);
  const workId = String(info.workId || "");

  if (!normalizedProfile || normalizedProfile.status !== "ready" || !workId) {
    return [];
  }
  if (!normalizedProfile.workIdParamNames || normalizedProfile.workIdParamNames.length === 0) {
    return [];
  }

  let url;
  try {
    url = new URL(normalizedProfile.endpoint);
  } catch {
    return [];
  }

  const idParamNames = new Set(normalizedProfile.workIdParamNames.map((name) => name.toLowerCase()));
  const seenParams = new Set();

  for (const [name, value] of normalizedProfile.queryParams) {
    const normalizedName = name.toLowerCase();
    seenParams.add(normalizedName);
    if (idParamNames.has(normalizedName)) {
      url.searchParams.append(name, buildWorkIdParamValue(name, workId));
      continue;
    }
    url.searchParams.append(name, value);
  }

  if (![...idParamNames].some((name) => seenParams.has(name))) {
    return [];
  }

  return [url.toString()];
}

export function buildProfileRequestHeaders(profile, options = {}) {
  const normalizedProfile = normalizeProfile(profile);
  const headers = {
    "user-agent": BROWSER_USER_AGENT,
    "accept": "application/json,text/plain,*/*"
  };

  for (const [name, value] of Object.entries(normalizedProfile?.requestHeaders || {})) {
    if (value) {
      headers[name] = value;
    }
  }

  if (!headers.referer && options.pageUrl) {
    headers.referer = String(options.pageUrl);
  }

  const cookieHeader = normalizedProfile?.cookieHeader || options.fallbackCookieHeader || "";
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }

  return headers;
}

export async function captureApiProfileFromBrowser(url, options = {}) {
  const chromiumImpl = options.chromium || chromium;
  const executablePath = options.executablePath || findSystemBrowserPath(options.browserPaths);
  if (!executablePath) {
    throw new Error("未找到系统 Chrome/Edge，无法预热参数画像。");
  }

  let browser;
  let context;
  let page;
  let captured = null;

  try {
    browser = await chromiumImpl.launch({
      headless: true,
      executablePath,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--lang=zh-CN",
        "--no-first-run",
        "--disable-dev-shm-usage"
      ]
    });
    context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1365, height: 768 }
    });
    page = await context.newPage();
    page.on("response", async (response) => {
      if (captured) {
        return;
      }
      const responseUrl = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (contentType.toLowerCase().includes("json") && isReusableDetailEndpoint(responseUrl)) {
        captured = {
          url: responseUrl,
          requestHeaders: {}
        };
        captured.requestHeaders = await readRequestHeaders(response.request());
      }
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs
    });
    await page.waitForTimeout(normalizePositiveNumber(options.waitAfterLoadMs, DEFAULT_PROFILE_WAIT_AFTER_LOAD_MS));

    if (context && captured) {
      captured.cookieHeader = normalizeCookies(await context.cookies([
        "https://www.douyin.com",
        "https://douyin.com"
      ]));
    }
  } finally {
    await safeClose(page);
    await safeClose(context);
    await safeClose(browser);
  }

  if (!captured?.url) {
    throw new Error("未捕获到 detail API JSON 请求。");
  }

  return extractApiProfileFromUrl(captured.url, {
    capturedAt: Date.now(),
    ttlMs: options.ttlMs,
    requestHeaders: captured.requestHeaders || {},
    cookieHeader: captured.cookieHeader || ""
  });
}

export function sanitizeProfileMessage(message = "") {
  let sanitized = String(message || "");
  for (const name of COOKIE_PARAM_NAMES) {
    sanitized = sanitized.replace(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*[^;&\\s,]+`, "gi"), `${name}=***`);
  }
  sanitized = sanitized.replace(/\b(a_bogus|x-secsdk-web-signature|timestamp)\s*=\s*[^;&\s,]+/gi, "$1=***");
  sanitized = sanitized.replace(/\b(storagePath|userDataDir|executablePath)\s*[:=]\s*[A-Za-z]:\\.*?(?=\s+\w+\s*[:=]|$)/gi, "$1=***");
  sanitized = sanitized.replace(/\b(storagePath|userDataDir|executablePath)\s*[:=]\s*[^;\s,]+/gi, "$1=***");
  sanitized = sanitized.replace(/[A-Za-z]:\\[^\s;,"'<>|]+/g, "[本地路径已隐藏]");
  return sanitized;
}

export function sanitizeProfileUrl(value = "") {
  const text = String(value || "");
  try {
    const url = new URL(text);
    const sanitized = new URL(`${url.origin}${url.pathname}`);
    for (const [name, paramValue] of url.searchParams.entries()) {
      sanitized.searchParams.append(name, isSensitiveQueryParam(name) ? "***" : paramValue);
    }
    return sanitized.toString();
  } catch {
    return sanitizeProfileMessage(text).replace(/\b(timestamp)\s*=\s*[^;&\s,]+/gi, "$1=***");
  }
}

function normalizeProfile(profile, options = {}) {
  if (!profile || typeof profile !== "object") {
    return null;
  }
  const capturedAt = Number(profile.capturedAt ?? options.capturedAt ?? Date.now());
  const ttlMs = normalizePositiveNumber(options.ttlMs, DEFAULT_API_PROFILE_TTL_MS);
  const queryParams = normalizeQueryParams(profile.queryParams);
  const volatileParamNames = [...new Set(profile.volatileParamNames || [])];
  const workIdParamNames = profile.workIdParamNames?.length
    ? [...new Set(profile.workIdParamNames)]
    : [...new Set(queryParams.map(([name]) => name).filter((name) => WORK_ID_PARAM_NAMES.has(name.toLowerCase())))];

  const normalized = {
    status: profile.status || "invalid",
    endpoint: profile.endpoint || "",
    queryParams,
    volatileParamNames,
    workIdParamNames,
    requestHeaders: normalizeRequestHeaders(profile.requestHeaders),
    cookieHeader: String(profile.cookieHeader || ""),
    capturedAt,
    expiresAt: Number(profile.expiresAt ?? capturedAt + ttlMs),
    sourceWorkId: profile.sourceWorkId || ""
  };
  normalized.safeStatus = buildSafeStatus(normalized);
  return normalized;
}

function normalizeQueryParams(queryParams) {
  if (Array.isArray(queryParams)) {
    return queryParams
      .filter((item) => Array.isArray(item) && item.length >= 2)
      .map(([name, value]) => [String(name), String(value)]);
  }
  if (queryParams && typeof queryParams === "object") {
    return Object.entries(queryParams).map(([name, value]) => [name, String(value)]);
  }
  return [];
}

function buildInvalidProfile(reason, options = {}) {
  const capturedAt = Number(options.capturedAt ?? Date.now());
  const profile = {
    status: "invalid",
    endpoint: "",
    queryParams: [],
    volatileParamNames: [],
    workIdParamNames: [],
    requestHeaders: {},
    cookieHeader: "",
    capturedAt,
    expiresAt: capturedAt,
    sourceWorkId: "",
    safeStatus: {
      status: "invalid",
      reason: sanitizeProfileMessage(reason)
    }
  };
  return profile;
}

function buildSafeStatus(profile) {
  return {
    status: profile.status || "invalid",
    endpoint: profile.endpoint || "",
    stableParamNames: profile.queryParams
      .map(([name]) => name)
      .filter((name) => !VOLATILE_PARAM_NAMES.has(name.toLowerCase())),
    volatileParamNames: profile.volatileParamNames || [],
    requestHeaderNames: Object.keys(profile.requestHeaders || {}).sort(),
    cookieCount: countCookies(profile.cookieHeader),
    capturedAt: profile.capturedAt || 0,
    expiresAt: profile.expiresAt || 0
  };
}

function normalizeRequestHeaders(headers = {}) {
  const normalized = {};
  if (!headers || typeof headers !== "object") {
    return normalized;
  }

  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = String(name || "").toLowerCase();
    if (!PROFILE_REQUEST_HEADER_ALLOWLIST.has(normalizedName)) {
      continue;
    }
    const normalizedValue = Array.isArray(value) ? value.join(", ") : String(value || "");
    if (normalizedValue) {
      normalized[normalizedName] = normalizedValue;
    }
  }

  return normalized;
}

function countCookies(cookieHeader = "") {
  return String(cookieHeader || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .length;
}

function buildWorkIdParamValue(name, workId) {
  return name.toLowerCase() === "aweme_ids" ? `[${workId}]` : workId;
}

function isSensitiveQueryParam(name) {
  const normalizedName = String(name || "").toLowerCase();
  return VOLATILE_PARAM_NAMES.has(normalizedName)
    || normalizedName === "mstoken"
    || normalizedName === "timestamp";
}

function isReusableDetailEndpoint(url) {
  const lowerUrl = String(url || "").toLowerCase();
  return DETAIL_API_KEYWORDS.some((keyword) => lowerUrl.includes(keyword.toLowerCase()));
}

function normalizePositiveNumber(value, defaultValue) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : defaultValue;
}

async function safeClose(target) {
  if (!target || typeof target.close !== "function") {
    return;
  }
  try {
    await target.close();
  } catch {
    // 预热清理失败不影响任务主流程。
  }
}

async function readRequestHeaders(request) {
  if (!request) {
    return {};
  }

  try {
    if (typeof request.allHeaders === "function") {
      return normalizeRequestHeaders(await request.allHeaders());
    }
    if (typeof request.headers === "function") {
      return normalizeRequestHeaders(await request.headers());
    }
  } catch {
    return {};
  }

  return {};
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
