import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createCookieStore,
  maskCookieSummary,
  normalizeCookies
} from "../src/cookie-store.js";
import { createGuestCookieRefresher } from "../src/cookie-refresher.js";

test("normalizeCookies 将 Playwright cookies 转为请求头字符串", () => {
  assert.equal(
    normalizeCookies([
      { name: "sessionid", value: "abc", domain: ".douyin.com" },
      { name: "ttwid", value: "xyz", domain: ".douyin.com" }
    ]),
    "sessionid=abc; ttwid=xyz"
  );
});

test("maskCookieSummary 不泄露 Cookie 明文", () => {
  const summary = maskCookieSummary("sessionid=abcdef; ttwid=xyz");
  assert.equal(summary.includes("abcdef"), false);
  assert.match(summary, /2 个 Cookie/);
});

test("createCookieStore 保存和读取本地 Cookie 状态", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-cookie-"));
  const store = createCookieStore({ storagePath: path.join(dir, "cookies.json") });

  await store.saveCookieHeader("sessionid=abc; ttwid=xyz");
  const status = await store.getStatus();
  const cookieHeader = await store.getCookieHeader();

  assert.equal(status.exists, true);
  assert.equal(status.summary, "2 个 Cookie");
  assert.equal(cookieHeader, "sessionid=abc; ttwid=xyz");
});

test("createCookieStore 遇到损坏 JSON 时抛出中文脱敏错误", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-cookie-"));
  const storagePath = path.join(dir, "cookies.json");
  const store = createCookieStore({ storagePath });

  await fs.writeFile(storagePath, '{"cookieHeader":"sessionid=secret"', "utf8");

  await assert.rejects(
    () => store.getStatus(),
    (error) => {
      assert.match(error.message, /Cookie 文件(读取失败|解析失败)/);
      assert.equal(error.message.includes("secret"), false);
      return true;
    }
  );
});

test("normalizeCookies 只保留抖音域 Cookie 并过滤无效项", () => {
  assert.equal(normalizeCookies([]), "");
  assert.equal(
    normalizeCookies([
      { name: "", value: "abc", domain: ".douyin.com" },
      { name: "empty", value: "", domain: ".douyin.com" },
      { name: "bad", value: "leak", domain: "example.com" },
      { name: "root", value: "abc", domain: ".douyin.com" },
      { name: "www", value: "xyz", domain: "www.douyin.com" }
    ]),
    "root=abc; www=xyz"
  );
});

test("createGuestCookieRefresher 采集无登录游客 Cookie 并发保存只运行一次", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "douyin-cookie-refresh-"));
  const store = createCookieStore({ storagePath: path.join(dir, "cookies.json") });
  const visitedUrls = [];
  const gotoOptions = [];
  const closed = [];
  let launchCount = 0;

  const refresher = createGuestCookieRefresher({
    cookieStore: store,
    waitAfterLoadMs: 0,
    launchBrowser: async () => {
      launchCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        async newContext(contextOptions) {
          assert.equal(contextOptions.locale, "zh-CN");
          return {
            async newPage() {
              return {
                async goto(url, options) {
                  visitedUrls.push(url);
                  gotoOptions.push(options);
                },
                async waitForTimeout() {},
                async close() {
                  closed.push("page");
                }
              };
            },
            async cookies() {
              return [
                { name: "ttwid", value: "visitor-secret", domain: ".douyin.com" },
                { name: "msToken", value: "token-secret", domain: "www.douyin.com" },
                { name: "bad", value: "leak", domain: "example.com" }
              ];
            },
            async close() {
              closed.push("context");
            }
          };
        },
        async close() {
          closed.push("browser");
        }
      };
    }
  });

  const [first, second] = await Promise.all([
    refresher.refresh(),
    refresher.refresh("https://www.douyin.com/video/123")
  ]);
  const cookieHeader = await store.getCookieHeader();

  assert.equal(launchCount, 1);
  assert.equal(visitedUrls.length, 1);
  assert.equal(visitedUrls[0], "https://www.douyin.com/");
  assert.equal(gotoOptions[0].waitUntil, "domcontentloaded");
  assert.equal(cookieHeader, "ttwid=visitor-secret; msToken=token-secret");
  assert.equal(first.exists, true);
  assert.equal(second.summary, "2 个 Cookie");
  assert.equal(JSON.stringify(second).includes("visitor-secret"), false);
  assert.deepEqual(closed.sort(), ["browser", "context", "page"]);
});
