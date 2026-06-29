export function isSupportedDouyinUrl(url) {
  return extractDouyinWorkInfo(url).supported;
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
  return hostname === "douyin.com" || hostname === "www.douyin.com";
}

function extractPathInfo(segments) {
  if (segments.length === 2 && ["video", "note"].includes(segments[0]) && segments[1]) {
    return {
      pathType: segments[0],
      workId: segments[1]
    };
  }

  if (segments.length === 3 && segments[0] === "share" && segments[1] === "video" && segments[2]) {
    return {
      pathType: "video",
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
