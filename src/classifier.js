const INVALID_TEXT_KEYWORDS = [
  "你要观看的视频不存在",
  "你要观看的图文不存在",
  "抱歉，作品不见了"
];

const ALIVE_TEXT_KEYWORDS = ["点赞", "评论", "发布时间", "关注"];

const RISK_TEXT_KEYWORDS = [
  "验证码",
  "登录",
  "请先登录",
  "安全验证",
  "访问过于频繁",
  "稍后再试",
  "verify",
  "captcha"
];

const RISK_API_KEYWORDS = RISK_TEXT_KEYWORDS;

const INVALID_MESSAGE_KEYWORDS = [
  "不存在",
  "作品不见了",
  "已删除",
  "下架",
  "不可见",
  "无权限",
  "权限"
];

export function classifyDetailResult(result = {}) {
  const {
    originalUrl = "",
    finalUrl = "",
    detailJson = null,
    fallbackText = "",
    error = "",
    apiParseErrors = []
  } = result;

  if (error && !isNonFatalApiParseError(error, apiParseErrors)) {
    return buildResult("待确认", inferContentType(detailJson, originalUrl, finalUrl), `采集过程出现错误：${error}`, "error");
  }

  if (detailJson) {
    const apiResult = classifyByDetailJson(detailJson, originalUrl, finalUrl);
    if (apiResult) {
      return apiResult;
    }
  }

  const domResult = classifyByDomText(fallbackText, detailJson, originalUrl, finalUrl);
  if (domResult) {
    return domResult;
  }

  return buildResult(
    "待确认",
    inferContentType(detailJson, originalUrl, finalUrl),
    "未捕获到可确认的 detail API 数据或页面文本。",
    "heuristic"
  );
}

function classifyByDetailJson(detailJson, originalUrl, finalUrl) {
  const payload = unwrapPayload(detailJson);
  const contentType = inferContentType(detailJson, originalUrl, finalUrl);
  const message = collectMessages(detailJson).join(" ");
  const hasErrorCode = hasStatusError(detailJson);
  const hasInvalidMessage = INVALID_MESSAGE_KEYWORDS.some((keyword) => message.includes(keyword));
  const hasRiskMessage = RISK_API_KEYWORDS.some((keyword) => message.toLowerCase().includes(keyword.toLowerCase()));
  const hasAliveEvidence = hasAliveStructuredEvidence(payload);
  const isVideoToNote = includesPath(originalUrl, "/video/") && includesPath(finalUrl, "/note/");

  if (hasRiskMessage) {
    return buildResult("待确认", contentType, `detail API 返回风控、登录或验证码提示：${message}`, "detail_api");
  }

  if (hasAliveEvidence) {
    if (isVideoToNote) {
      return buildResult("存活", "图文", "detail API 返回有效作品数据，视频链接跳转图文。", "url_redirect");
    }

    return buildResult("存活", contentType, "detail API 返回有效作品数据。", "detail_api");
  }

  const coreEmpty = hasEmptyCoreContent(detailJson);
  if (coreEmpty && (hasErrorCode || hasInvalidMessage)) {
    const status = hasInvalidMessage || isKnownInvalidCode(detailJson) ? "失效" : "待确认";
    return buildResult(status, contentType, `detail API 返回空作品数据：${message || "存在错误状态码"}`, "detail_api");
  }

  if (hasErrorCode) {
    return buildResult("待确认", contentType, `detail API 返回异常状态：${message || "未提供错误文案"}`, "detail_api");
  }

  return null;
}

function classifyByDomText(text, detailJson, originalUrl, finalUrl) {
  const normalized = String(text || "");
  if (!normalized.trim()) {
    return null;
  }

  const contentType = inferContentType(detailJson, originalUrl, finalUrl);
  const invalidKeyword = INVALID_TEXT_KEYWORDS.find((keyword) => normalized.includes(keyword));
  if (invalidKeyword) {
    return buildResult("失效", contentType, `DOM 文本包含失效提示：${invalidKeyword}`, "dom_text");
  }

  const riskKeyword = RISK_TEXT_KEYWORDS.find((keyword) => normalized.toLowerCase().includes(keyword.toLowerCase()));
  if (riskKeyword) {
    return buildResult("待确认", contentType, `页面出现风控、登录或验证提示：${riskKeyword}`, "heuristic");
  }

  const aliveKeyword = ALIVE_TEXT_KEYWORDS.find((keyword) => normalized.includes(keyword));
  if (aliveKeyword) {
    return buildResult("存活", contentType, `DOM 文本包含存活关键词：${aliveKeyword}`, "dom_text");
  }

  return null;
}

function isNonFatalApiParseError(error, apiParseErrors) {
  if (!Array.isArray(apiParseErrors) || apiParseErrors.length === 0) {
    return false;
  }

  const hasParseFailureRecord = apiParseErrors.some((entry) => {
    if (typeof entry === "string") {
      return entry.includes("解析失败");
    }

    return typeof entry?.message === "string" && entry.message.includes("解析失败");
  });

  return hasParseFailureRecord && String(error || "").includes("detail API 响应 JSON 解析失败");
}

function buildResult(status, contentType, reason, basis) {
  return {
    status,
    contentType,
    reason,
    basis
  };
}

function unwrapPayload(detailJson) {
  if (!detailJson || typeof detailJson !== "object") {
    return null;
  }

  if (isNonEmptyObject(detailJson.aweme_detail)) {
    return detailJson.aweme_detail;
  }

  if (Array.isArray(detailJson.aweme_list) && detailJson.aweme_list.length > 0) {
    return detailJson.aweme_list[0];
  }

  if (Array.isArray(detailJson.item_list) && detailJson.item_list.length > 0) {
    return detailJson.item_list[0];
  }

  if (isNonEmptyObject(detailJson.data)) {
    if (isNonEmptyObject(detailJson.data.aweme_detail)) {
      return detailJson.data.aweme_detail;
    }
    if (Array.isArray(detailJson.data.item_list) && detailJson.data.item_list.length > 0) {
      return detailJson.data.item_list[0];
    }
    return detailJson.data;
  }

  return detailJson;
}

export function hasDetailWorkCandidate(detailJson) {
  return hasAliveStructuredEvidence(unwrapPayload(detailJson));
}

function hasAliveStructuredEvidence(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  if (hasStringValue(payload.aweme_id) && (hasPlayableMediaEvidence(payload) || isNonEmptyObject(payload.statistics) || hasStringValue(payload.desc))) {
    return true;
  }

  if (isNonEmptyObject(payload.statistics) && hasPlayableMediaEvidence(payload)) {
    return true;
  }

  if (hasPlayableMediaEvidence(payload) && (hasStringValue(payload.desc) || hasStringValue(payload.title) || hasStringValue(payload.aweme_id))) {
    return true;
  }

  return false;
}

function hasPlayableMediaEvidence(payload) {
  return isNonEmptyObject(payload?.video) || hasImageEvidence(payload);
}

function hasImageEvidence(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  if (Array.isArray(payload.images) && payload.images.length > 0) {
    return true;
  }

  if (isNonEmptyObject(payload.image_post_info)) {
    return true;
  }

  if (Array.isArray(payload.image_post_info?.images) && payload.image_post_info.images.length > 0) {
    return true;
  }

  return false;
}

function inferContentType(detailJson, originalUrl, finalUrl) {
  const payload = unwrapPayload(detailJson);

  if (hasImageEvidence(payload) || includesPath(finalUrl, "/note/") || includesPath(originalUrl, "/note/")) {
    return "图文";
  }

  if (isNonEmptyObject(payload?.video) || includesPath(finalUrl, "/video/") || includesPath(finalUrl, "/share/video/") || includesPath(originalUrl, "/video/") || includesPath(originalUrl, "/share/video/")) {
    return "视频";
  }

  return "未知";
}

function hasEmptyCoreContent(detailJson) {
  if (!detailJson || typeof detailJson !== "object") {
    return false;
  }

  const coreKeys = ["aweme_detail", "item_list", "aweme_list", "data"];
  return coreKeys.some((key) => Object.hasOwn(detailJson, key) && isEmptyValue(detailJson[key]));
}

function isEmptyValue(value) {
  if (value === null || value === undefined) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }

  return false;
}

function hasStatusError(detailJson) {
  const codes = [
    detailJson?.status_code,
    detailJson?.statusCode,
    detailJson?.code,
    detailJson?.error_code,
    detailJson?.err_no
  ];

  return codes.some((code) => {
    if (code === undefined || code === null || code === 0 || code === "0") {
      return false;
    }
    return true;
  }) || collectMessages(detailJson).length > 0;
}

function isKnownInvalidCode(detailJson) {
  const codes = [
    detailJson?.status_code,
    detailJson?.statusCode,
    detailJson?.code,
    detailJson?.error_code,
    detailJson?.err_no
  ].map((code) => Number(code));

  return codes.some((code) => [8, 10204, 10010, 404].includes(code));
}

function collectMessages(value, messages = []) {
  if (!value || typeof value !== "object") {
    return messages;
  }

  for (const [key, child] of Object.entries(value)) {
    if (["status_msg", "statusMessage", "message", "msg", "errmsg", "error_msg", "errorMessage", "detail_msg", "detailMsg"].includes(key) && typeof child === "string" && child.trim()) {
      messages.push(child.trim());
    } else if (child && typeof child === "object" && messages.length < 12) {
      collectMessages(child, messages);
    }
  }

  return messages;
}

function includesPath(url, path) {
  return String(url || "").includes(path);
}

function hasStringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}
