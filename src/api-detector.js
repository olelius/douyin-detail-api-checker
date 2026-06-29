import { BROWSER_USER_AGENT, DEFAULT_API_OPTIONS } from "./config.js";
import { extractDouyinWorkInfo, isDouyinShortUrl } from "./url-utils.js";
import { buildProfileCandidates, buildProfileRequestHeaders, sanitizeProfileMessage, sanitizeProfileUrl } from "./api-profile-cache.js";

const RISK_API_KEYWORDS = [
  "验证码",
  "登录",
  "请先登录",
  "安全验证",
  "访问过于频繁",
  "稍后再试",
  "captcha",
  "verify"
];

const RISK_MESSAGE_KEYS = [
  "status_msg",
  "statusMessage",
  "message",
  "msg",
  "errmsg",
  "error_msg",
  "errorMessage",
  "detail_msg",
  "detailMsg"
];

export function buildDetailApiCandidates(info = {}) {
  const workId = encodeURIComponent(String(info.workId || ""));
  return [
    `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${workId}`,
    `https://www.douyin.com/aweme/v1/web/multi/aweme/detail/?aweme_ids=%5B${workId}%5D`,
    `https://www.douyin.com/aweme/v1/web/note/detail/?item_id=${workId}`
  ];
}

export function createApiDetector(options = {}) {
  const config = { ...DEFAULT_API_OPTIONS, ...options };
  const fetchImpl = config.fetchImpl || globalThis.fetch;

  return {
    async detect(url) {
      const startedAt = new Date();
      let pageUrl = url;
      const shortUrl = isDouyinShortUrl(url);

      if (shortUrl) {
        if (typeof fetchImpl !== "function") {
          return buildFallbackEvidence({
            url,
            startedAt,
            errorType: "fetch_unavailable",
            error: "当前 Node.js 环境不支持 fetch，请注入 fetchImpl。"
          });
        }

        const resolved = await resolveShortUrl({
          url,
          fetchImpl,
          cookieHeader: config.cookieHeader || "",
          timeoutMs: config.timeoutMs
        });
        if (!resolved.ok) {
          return buildFallbackEvidence({
            url,
            finalUrl: resolved.finalUrl || url,
            startedAt,
            errorType: resolved.errorType,
            error: resolved.error
          });
        }
        pageUrl = resolved.finalUrl;
      }

      const info = extractDouyinWorkInfo(pageUrl);

      if (!info.supported) {
        return buildFallbackEvidence({
          url,
          finalUrl: pageUrl,
          startedAt,
          errorType: "unsupported_url",
          error: "不属于支持的抖音作品链接。"
        });
      }

      if (typeof fetchImpl !== "function") {
        return buildFallbackEvidence({
          url,
          startedAt,
          errorType: "fetch_unavailable",
          error: "当前 Node.js 环境不支持 fetch，请注入 fetchImpl。"
        });
      }

      const failures = [];
      const candidateItems = buildCandidateItems(info, config);
      const profileStatus = getProfileStatus(config);
      const hasProfileCandidates = candidateItems.some((item) => item.source === "profile");
      const candidateSources = uniqueSources(candidateItems);

      for (const item of candidateItems) {
        const apiUrl = item.url;
        const safeApiUrl = sanitizeProfileUrl(apiUrl);
        const requestHeaders = item.source === "profile"
          ? buildProfileRequestHeaders(item.profile, {
            pageUrl,
            fallbackCookieHeader: config.cookieHeader || ""
          })
          : null;
        const responseEvidence = await requestDetailApi({
          apiUrl,
          pageUrl,
          fetchImpl,
          cookieHeader: config.cookieHeader || "",
          requestHeaders,
          timeoutMs: config.timeoutMs
        });

        if (responseEvidence.needsFallback) {
          failures.push({
            ...responseEvidence,
            apiUrl: safeApiUrl,
            apiCandidateSource: item.source
          });
          continue;
        }

        const risk = isRiskApiPayload(responseEvidence.detailJson);
        if (risk) {
          return {
            stage: "api",
            originalUrl: url,
            finalUrl: pageUrl,
            apiUrl: safeApiUrl,
            detailJson: responseEvidence.detailJson,
            needsFallback: true,
            errorType: "risk_control",
            error: "detail API 返回登录、验证码或访问频繁提示，需进入兜底检测。",
            apiCacheUsed: hasProfileCandidates,
            apiProfileStatus: profileStatus,
            apiCandidateSource: item.source,
            apiCandidateSources: candidateSources,
            startedAt,
            finishedAt: new Date()
          };
        }

        return {
          stage: "api",
          originalUrl: url,
          finalUrl: pageUrl,
          apiUrl: safeApiUrl,
          detailJson: responseEvidence.detailJson,
          needsFallback: false,
          errorType: "",
          error: "",
          apiCacheUsed: hasProfileCandidates,
          apiProfileStatus: profileStatus,
          apiCandidateSource: item.source,
          apiCandidateSources: candidateSources,
          startedAt,
          finishedAt: new Date()
        };
      }

      if (failures.length > 0) {
        return buildFallbackEvidence({
          url,
          startedAt,
          apiUrl: failures.at(-1).apiUrl,
          detailJson: null,
          errorType: summarizeFailureType(failures),
          error: summarizeFailures(failures),
          apiCacheUsed: hasProfileCandidates,
          apiProfileStatus: profileStatus,
          apiCandidateSource: failures.at(-1)?.apiCandidateSource || "",
          apiCandidateSources: candidateSources
        });
      }

      return buildFallbackEvidence({
        url,
        startedAt,
        errorType: "no_api_candidate",
        error: "未生成可用的 detail API 候选地址。",
        apiCacheUsed: false,
        apiProfileStatus: profileStatus,
        apiCandidateSource: "",
        apiCandidateSources: []
      });
    }
  };
}

export function isRiskApiPayload(payload) {
  return collectRiskMessages(payload).some((message) => {
    const normalized = message.toLowerCase();
    return RISK_API_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase()));
  });
}

function collectRiskMessages(value, options = {}) {
  const {
    maxDepth = 6,
    maxMessages = 20,
    maxNodes = 200
  } = options;
  const messages = [];
  let visitedNodes = 0;

  function visit(node, depth) {
    if (!node || typeof node !== "object" || depth > maxDepth || messages.length >= maxMessages || visitedNodes >= maxNodes) {
      return;
    }

    visitedNodes += 1;
    for (const [key, child] of Object.entries(node)) {
      if (RISK_MESSAGE_KEYS.includes(key) && typeof child === "string" && child.trim()) {
        messages.push(child.trim());
        if (messages.length >= maxMessages) {
          return;
        }
        continue;
      }

      if (child && typeof child === "object") {
        visit(child, depth + 1);
        if (messages.length >= maxMessages || visitedNodes >= maxNodes) {
          return;
        }
      }
    }
  }

  visit(value, 0);
  return messages;
}

async function resolveShortUrl({ url, fetchImpl, cookieHeader, timeoutMs }) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller && Number.isFinite(timeoutMs)
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const headers = {
    "user-agent": BROWSER_USER_AGENT,
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "cookie": cookieHeader
  };

  try {
    let currentUrl = url;
    for (let index = 0; index < 5; index += 1) {
      const response = await fetchImpl(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller?.signal
      });
      const location = getHeaderValue(response.headers, "location");

      if (response.status >= 300 && response.status < 400 && location) {
        currentUrl = new URL(location, currentUrl).toString();
        if (!isDouyinShortUrl(currentUrl)) {
          return {
            ok: true,
            finalUrl: currentUrl
          };
        }
        continue;
      }

      if (response.url && response.url !== currentUrl) {
        return {
          ok: true,
          finalUrl: response.url
        };
      }

      return {
        ok: false,
        finalUrl: currentUrl,
        errorType: "unsupported_url",
        error: "短链未返回可解析的作品落地链接。"
      };
    }

    return {
      ok: false,
      finalUrl: currentUrl,
      errorType: "unsupported_url",
      error: "短链跳转次数过多，未解析到作品落地链接。"
    };
  } catch (error) {
    return {
      ok: false,
      finalUrl: url,
      errorType: error?.name === "AbortError" ? "timeout" : "request_error",
      error: sanitizeErrorMessage(error, cookieHeader)
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function requestDetailApi({ apiUrl, pageUrl, fetchImpl, cookieHeader, requestHeaders, timeoutMs }) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller && Number.isFinite(timeoutMs)
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const headers = requestHeaders || {
    "user-agent": BROWSER_USER_AGENT,
    "accept": "application/json,text/plain,*/*",
    "cookie": cookieHeader,
    "referer": pageUrl
  };
  const effectiveCookieHeader = headers.cookie || cookieHeader || "";

  try {
    const response = await fetchImpl(apiUrl, {
      method: "GET",
      headers,
      signal: controller?.signal
    });

    if (!response.ok) {
      return {
        stage: "api",
        apiUrl,
        detailJson: null,
        needsFallback: true,
        errorType: "http_status",
        error: `detail API 请求失败：HTTP 状态码 ${response.status}。`
      };
    }

    return {
      stage: "api",
      apiUrl,
      detailJson: await response.json(),
      needsFallback: false,
      errorType: "",
      error: ""
    };
  } catch (error) {
    return {
      stage: "api",
      apiUrl,
      detailJson: null,
      needsFallback: true,
      errorType: error?.name === "AbortError" ? "timeout" : "request_error",
      error: sanitizeErrorMessage(error, effectiveCookieHeader)
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function getHeaderValue(headers, name) {
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return headers.get(name) || "";
  }
  return headers[name] || headers[name.toLowerCase()] || "";
}

function buildFallbackEvidence({
  url,
  finalUrl = url,
  startedAt,
  apiUrl = "",
  detailJson = null,
  errorType,
  error,
  apiCacheUsed = false,
  apiProfileStatus = "none",
  apiCandidateSource = "",
  apiCandidateSources = []
}) {
  return {
    stage: "api",
    originalUrl: url,
    finalUrl,
    apiUrl,
    detailJson,
    needsFallback: true,
    errorType,
    error,
    apiCacheUsed,
    apiProfileStatus,
    apiCandidateSource,
    apiCandidateSources,
    startedAt,
    finishedAt: new Date()
  };
}

function buildCandidateItems(info, config) {
  const profile = config.apiProfile || config.profile || config.apiProfileCache?.getProfile?.();
  const profileCandidates = buildProfileCandidates(profile, info).map((url) => ({ url, source: "profile", profile }));
  const defaultCandidates = buildDetailApiCandidates(info).map((url) => ({ url, source: "default" }));
  const seen = new Set();
  return [...profileCandidates, ...defaultCandidates].filter((item) => {
    if (!item.url || seen.has(item.url)) {
      return false;
    }
    seen.add(item.url);
    return true;
  });
}

function getProfileStatus(config) {
  if (config.apiProfile?.status) {
    return config.apiProfile.status;
  }
  if (config.profile?.status) {
    return config.profile.status;
  }
  const cacheStatus = config.apiProfileCache?.getStatus?.();
  return cacheStatus?.status || "none";
}

function uniqueSources(candidateItems) {
  return [...new Set(candidateItems.map((item) => item.source).filter(Boolean))];
}

function summarizeFailures(failures) {
  return failures
    .map((failure, index) => `候选 ${index + 1} ${failure.errorType || "unknown"}：${failure.error || "未知失败"}`)
    .join("；");
}

function summarizeFailureType(failures) {
  const types = [...new Set(failures.map((failure) => failure.errorType).filter(Boolean))];
  return types.length === 1 ? types[0] : "api_candidates_failed";
}

function sanitizeErrorMessage(error, cookieHeader = "") {
  const message = error?.name === "AbortError"
    ? "detail API 请求超时。"
    : `detail API 请求异常：${error?.message || "未知错误"}`;
  return sanitizeProfileMessage(maskKnownCookieValues(maskCookieHeaderValues(message, cookieHeader)));
}

function maskCookieHeaderValues(message, cookieHeader) {
  let masked = message;
  for (const item of String(cookieHeader || "").split(";")) {
    const [name, ...valueParts] = item.trim().split("=");
    const value = valueParts.join("=");
    if (!name || !value) {
      continue;
    }

    masked = masked.replace(new RegExp(`${escapeRegExp(name)}\\s*=\\s*${escapeRegExp(value)}`, "gi"), `${name}=***`);
  }
  return masked;
}

function maskKnownCookieValues(message) {
  return message.replace(
    /\b(sessionid|ttwid|sid_guard|uid_tt|passport_csrf_token|msToken|odin_tt|__ac_nonce|__ac_signature)\s*=\s*[^;\s,]+/gi,
    "$1=***"
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
