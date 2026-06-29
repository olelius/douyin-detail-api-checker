import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_COOKIE_PATH = path.resolve(process.cwd(), ".local", "cookies.json");

export function createCookieStore(options = {}) {
  const storagePath = options.storagePath || DEFAULT_COOKIE_PATH;

  return {
    storagePath,
    async getStatus() {
      const data = await readCookieFile(storagePath);
      const cookieHeader = data.cookieHeader || "";

      return {
        exists: Boolean(cookieHeader),
        storagePath,
        summary: maskCookieSummary(cookieHeader),
        refreshedAt: cookieHeader ? data.refreshedAt || "" : ""
      };
    },
    async getCookieHeader() {
      return readCookieHeader(storagePath);
    },
    async saveCookieHeader(cookieHeader) {
      await fs.mkdir(path.dirname(storagePath), { recursive: true });
      await fs.writeFile(storagePath, JSON.stringify({
        cookieHeader: String(cookieHeader || ""),
        refreshedAt: new Date().toISOString()
      }, null, 2), "utf8");
    }
  };
}

export function normalizeCookies(cookies = []) {
  return cookies
    .filter((cookie) => cookie?.name && cookie?.value && isDouyinCookieDomain(cookie.domain))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function maskCookieSummary(cookieHeader = "") {
  const count = String(cookieHeader)
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .length;

  return count > 0 ? `${count} 个 Cookie` : "未保存 Cookie";
}

async function readCookieHeader(storagePath) {
  const data = await readCookieFile(storagePath);
  return data.cookieHeader || "";
}

async function readCookieFile(storagePath) {
  let text = "";
  try {
    text = await fs.readFile(storagePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw new Error(`Cookie 文件读取失败: ${sanitizeFileError(error)}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Cookie 文件解析失败: ${sanitizeFileError(error)}`);
  }
}

function isDouyinCookieDomain(domain) {
  const normalized = String(domain || "").trim().toLowerCase();
  return normalized === "douyin.com" || normalized.endsWith(".douyin.com");
}

function sanitizeFileError(error) {
  const code = error?.code ? `错误码 ${error.code}` : "未知错误";
  if (error instanceof SyntaxError) {
    return "JSON 格式无效";
  }

  return code;
}
