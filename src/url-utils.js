export function isSupportedDouyinUrl(url) {
  return extractDouyinWorkInfo(url).supported;
}

export function isDouyinShortUrl(url) {
  const parsed = parseUrl(String(url || "").trim());
  return Boolean(parsed && parsed.hostname === "v.douyin.com");
}

export function extractDouyinWorkInfo(url) {
  const text = String(url || "").trim();
  const parsed = parseUrl(text);
  if (!parsed || !isDouyinHost(parsed.hostname)) {
    return buildUnsupportedResult();
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const pathInfo = extractPathInfo(segments);
  if (!pathInfo) {
    return buildUnsupportedResult();
  }

  return {
    supported: true,
    type: pathInfo.pathType === "note" ? "图文" : "视频",
    pathType: pathInfo.pathType,
    workId: pathInfo.workId
  };
}

function parseUrl(text) {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function isDouyinHost(hostname) {
  return [
    "douyin.com",
    "www.douyin.com",
    "iesdouyin.com",
    "www.iesdouyin.com"
  ].includes(hostname);
}

function extractPathInfo(segments) {
  if (segments.length === 2 && ["video", "note"].includes(segments[0]) && segments[1]) {
    return {
      pathType: segments[0],
      workId: segments[1]
    };
  }

  if (segments.length === 3 && segments[0] === "share" && ["video", "note", "slides"].includes(segments[1]) && segments[2]) {
    return {
      pathType: segments[1] === "video" ? "video" : "note",
      workId: segments[2]
    };
  }

  return null;
}

function buildUnsupportedResult() {
  return {
    supported: false,
    type: "未知",
    pathType: "unknown",
    workId: ""
  };
}
