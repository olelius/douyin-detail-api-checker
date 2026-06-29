export const DEFAULT_OPTIONS = {
  concurrency: 1,
  delayMs: 1000,
  timeoutMs: 15000,
  waitAfterLoadMs: 6000
};

export const DEFAULT_UI_SERVICE = {
  host: "127.0.0.1",
  port: 3000,
  openBrowser: true
};

export const DEFAULT_API_OPTIONS = {
  concurrency: 5,
  delayMs: 1000,
  timeoutMs: 15000
};

export const DEFAULT_FALLBACK_OPTIONS = {
  concurrency: 2,
  delayMs: 1000,
  timeoutMs: 15000,
  waitAfterLoadMs: DEFAULT_OPTIONS.waitAfterLoadMs
};

export function getUiServiceConfig(env = process.env) {
  const port = env.UI_PORT === undefined ? DEFAULT_UI_SERVICE.port : Number(env.UI_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("UI_PORT 必须是 1 到 65535 之间的整数");
  }
  const host = env.UI_HOST || DEFAULT_UI_SERVICE.host;
  if (host !== "127.0.0.1") {
    throw new Error("UI_HOST 只允许使用本地地址 127.0.0.1");
  }

  return {
    host,
    port,
    openBrowser: env.UI_OPEN_BROWSER === "0" ? false : DEFAULT_UI_SERVICE.openBrowser
  };
}

export const DEFAULT_INPUT_CANDIDATES = [
  "input/测试.xlsx",
  "input/test.xlsx",
  "../python_playwright_dom_text/test.xlsx"
];

export const DEFAULT_OUTPUT_PATH = "output/检测结果.xlsx";

export const DETAIL_API_KEYWORDS = [
  "aweme/detail",
  "aweme/v1/web/aweme/detail",
  "multi/aweme/detail",
  "aweme/v1/web/multi/aweme/detail",
  "aweme/v1/web/note/detail",
  "aweme/v1/web/aweme/post"
];

export const SYSTEM_BROWSER_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
