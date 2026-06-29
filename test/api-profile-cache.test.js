import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProfileRequestHeaders,
  buildProfileCandidates,
  captureApiProfileFromBrowser,
  createApiProfileCache,
  extractApiProfileFromUrl,
  sanitizeProfileMessage
} from "../src/api-profile-cache.js";

test("从真实捕获 URL 生成画像并替换不同作品 ID 参数", () => {
  const capturedUrl = "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=111&item_id=111&aweme_ids=%5B111%5D&webid=web-1&verifyFp=verify-1&uifid=uifid-1&device_platform=webapp&a_bogus=secret-a&x-secsdk-web-signature=secret-sign&msToken=secret-ms&timestamp=123456";
  const profile = extractApiProfileFromUrl(capturedUrl, {
    capturedAt: 1000,
    ttlMs: 600000,
    sourceWorkId: "111"
  });

  const candidates = buildProfileCandidates(profile, { workId: "222", pathType: "video" });

  assert.equal(profile.endpoint, "https://www.douyin.com/aweme/v1/web/aweme/detail/");
  assert.equal(candidates.length, 1);
  const generated = new URL(candidates[0]);
  assert.equal(generated.searchParams.get("aweme_id"), "222");
  assert.equal(generated.searchParams.get("item_id"), "222");
  assert.equal(generated.searchParams.get("aweme_ids"), "[222]");
  assert.equal(generated.searchParams.get("webid"), "web-1");
  assert.equal(generated.searchParams.get("verifyFp"), "verify-1");
  assert.equal(generated.searchParams.get("uifid"), "uifid-1");
  assert.equal(generated.searchParams.get("a_bogus"), "secret-a");
  assert.equal(generated.searchParams.get("x-secsdk-web-signature"), "secret-sign");
  assert.equal(generated.searchParams.get("msToken"), "secret-ms");
  assert.equal(generated.searchParams.get("timestamp"), "123456");
});

test("签名类 volatile 参数跨作品完整复用且 safeStatus 不泄露参数值", () => {
  const profile = extractApiProfileFromUrl(
    "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=111&a_bogus=secret-a&x-secsdk-web-signature=secret-sign&msToken=secret-ms&timestamp=123456&webid=web-1",
    { capturedAt: 1000, ttlMs: 600000, sourceWorkId: "111" }
  );

  const [candidate] = buildProfileCandidates(profile, { workId: "222", pathType: "video" });
  const statusText = JSON.stringify(profile.safeStatus);

  assert.equal(new URL(candidate).searchParams.get("aweme_id"), "222");
  assert.equal(new URL(candidate).searchParams.get("a_bogus"), "secret-a");
  assert.equal(new URL(candidate).searchParams.get("x-secsdk-web-signature"), "secret-sign");
  assert.equal(new URL(candidate).searchParams.get("msToken"), "secret-ms");
  assert.equal(new URL(candidate).searchParams.get("timestamp"), "123456");
  assert.deepEqual(profile.volatileParamNames.sort(), ["a_bogus", "msToken", "x-secsdk-web-signature"].sort());
  assert.match(statusText, /a_bogus/);
  assert.match(statusText, /x-secsdk-web-signature/);
  assert.match(statusText, /msToken/);
  assert.doesNotMatch(statusText, /secret-a|secret-sign|secret-ms/);
});

test("画像保存真实请求 headers 和 Cookie，但 safeStatus 只暴露安全摘要", () => {
  const profile = extractApiProfileFromUrl(
    "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=111&a_bogus=secret-a&msToken=secret-ms&webid=web-1&uifid=query-uifid",
    {
      capturedAt: 1000,
      ttlMs: 600000,
      sourceWorkId: "111",
      requestHeaders: {
        "user-agent": "Mozilla/5.0 Chrome/125.0.0.0",
        accept: "application/json",
        "accept-language": "zh-CN,zh;q=0.9",
        referer: "https://www.douyin.com/video/111",
        "sec-ch-ua": "\"Chromium\";v=\"125\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        uifid: "header-uifid-secret",
        cookie: "sessionid=request-cookie-should-not-copy",
        "x-secsdk-web-signature": "header-sign-secret"
      },
      cookieHeader: "sessionid=secret-session; ttwid=secret-ttwid"
    }
  );

  const headers = buildProfileRequestHeaders(profile, {
    pageUrl: "https://www.douyin.com/video/222",
    fallbackCookieHeader: "sessionid=config-cookie"
  });
  const statusText = JSON.stringify(profile.safeStatus);

  assert.equal(profile.requestHeaders["accept-language"], "zh-CN,zh;q=0.9");
  assert.equal(profile.cookieHeader, "sessionid=secret-session; ttwid=secret-ttwid");
  assert.equal(headers["accept-language"], "zh-CN,zh;q=0.9");
  assert.equal(headers.uifid, "header-uifid-secret");
  assert.equal(headers.cookie, "sessionid=secret-session; ttwid=secret-ttwid");
  assert.equal(headers.referer, "https://www.douyin.com/video/111");
  assert.equal(headers["x-secsdk-web-signature"], undefined);
  assert.match(statusText, /requestHeaderNames/);
  assert.match(statusText, /cookieCount/);
  assert.match(statusText, /accept-language|uifid/);
  assert.doesNotMatch(statusText, /secret-session|secret-ttwid|header-uifid-secret|header-sign-secret|secret-a|secret-ms/);
});

test("aweme_ids 种子候选只替换为目标 ID 数组", () => {
  const profile = extractApiProfileFromUrl(
    "https://www.douyin.com/aweme/v1/web/multi/aweme/detail/?aweme_ids=%5B111%5D&a_bogus=secret-a&webid=web-1",
    { capturedAt: 1000, ttlMs: 600000, sourceWorkId: "111" }
  );

  const [candidate] = buildProfileCandidates(profile, { workId: "222", pathType: "video" });
  const generated = new URL(candidate);

  assert.equal(generated.searchParams.get("aweme_ids"), "[222]");
  assert.equal(generated.searchParams.get("a_bogus"), "secret-a");
  assert.equal(generated.searchParams.get("webid"), "web-1");
});

test("画像候选按种子 query 顺序保留重复非 ID 参数", () => {
  const profile = extractApiProfileFromUrl(
    "https://www.douyin.com/aweme/v1/web/aweme/detail/?foo=1&aweme_id=111&foo=2&a_bogus=secret-a&foo=3",
    { capturedAt: 1000, ttlMs: 600000, sourceWorkId: "111" }
  );

  const [candidate] = buildProfileCandidates(profile, { workId: "222", pathType: "video" });
  const generated = new URL(candidate);

  assert.deepEqual([...generated.searchParams.entries()], [
    ["foo", "1"],
    ["aweme_id", "222"],
    ["foo", "2"],
    ["a_bogus", "secret-a"],
    ["foo", "3"]
  ]);
});

test("TTL 未过期时复用画像，过期后重新预热", async () => {
  let now = 1000;
  let captures = 0;
  const cache = createApiProfileCache({
    ttlMs: 5000,
    now: () => now,
    captureProfile: async () => {
      captures += 1;
      return extractApiProfileFromUrl(
        `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${captures}&webid=web-${captures}`,
        { capturedAt: now, ttlMs: 5000, sourceWorkId: String(captures) }
      );
    }
  });

  await cache.ensureProfile("https://www.douyin.com/video/1");
  await cache.ensureProfile("https://www.douyin.com/video/2");
  now = 7000;
  await cache.ensureProfile("https://www.douyin.com/video/3");

  assert.equal(captures, 2);
  assert.equal(cache.getStatus().status, "ready");
});

test("并发预热只实际运行一次", async () => {
  let captures = 0;
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const cache = createApiProfileCache({
    captureProfile: async () => {
      captures += 1;
      await blocker;
      return extractApiProfileFromUrl(
        "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=111&webid=web-1",
        { capturedAt: Date.now(), ttlMs: 600000, sourceWorkId: "111" }
      );
    }
  });

  const warmups = Promise.all([
    cache.ensureProfile("https://www.douyin.com/video/111"),
    cache.ensureProfile("https://www.douyin.com/video/111"),
    cache.ensureProfile("https://www.douyin.com/video/111")
  ]);
  release();
  await warmups;

  assert.equal(captures, 1);
});

test("预热失败返回脱敏原因且不缓存敏感值", async () => {
  const cache = createApiProfileCache({
    captureProfile: async () => {
      throw new Error("预热失败：Cookie sessionid=secret; storagePath=C:\\Users\\me\\profile; a_bogus=secret-sign");
    }
  });

  const result = await cache.ensureProfile("https://www.douyin.com/video/111");
  const statusText = JSON.stringify(cache.getStatus());

  assert.equal(result.ok, false);
  assert.match(result.error, /sessionid=\*\*\*/);
  assert.match(result.error, /storagePath=\*\*\*/);
  assert.match(result.error, /a_bogus=\*\*\*/);
  assert.doesNotMatch(statusText, /secret|Users\\me/);
});

test("sanitizeProfileMessage 脱敏 Cookie、本地路径和签名参数", () => {
  const message = sanitizeProfileMessage("sessionid=abc ttwid=def storagePath=D:\\tmp\\profile a_bogus=xyz x-secsdk-web-signature=secret-sign");

  assert.equal(message.includes("abc"), false);
  assert.equal(message.includes("def"), false);
  assert.equal(message.includes("D:\\tmp"), false);
  assert.equal(message.includes("xyz"), false);
  assert.equal(message.includes("secret-sign"), false);
});

test("sanitizeProfileMessage 完整隐藏 Windows 绝对路径和敏感路径字段", () => {
  const message = sanitizeProfileMessage(
    "executablePath=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe " +
    "storagePath=D:\\hongye\\douyin_url\\.local\\profile " +
    "普通路径 D:\\hongye\\douyin_url\\methods\\node_detail_api"
  );

  assert.doesNotMatch(message, /Program Files|Google|chrome\.exe/);
  assert.doesNotMatch(message, /D:\\hongye|douyin_url|node_detail_api/);
  assert.match(message, /executablePath=\*\*\*/);
  assert.match(message, /storagePath=\*\*\*/);
  assert.match(message, /\[本地路径已隐藏\]/);
});

test("captureApiProfileFromBrowser 在 goto 异常时仍关闭 page、context 和 browser", async () => {
  const closed = [];
  const fakeChromium = {
    async launch() {
      return {
        async newContext() {
          return {
            async newPage() {
              return {
                on() {},
                async goto() {
                  throw new Error("goto failed");
                },
                async waitForTimeout() {},
                async close() {
                  closed.push("page");
                }
              };
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
  };

  await assert.rejects(
    () => captureApiProfileFromBrowser("https://www.douyin.com/video/123", {
      chromium: fakeChromium,
      executablePath: "C:\\fake\\chrome.exe",
      waitAfterLoadMs: 1
    }),
    /goto failed/
  );

  assert.deepEqual(closed, ["page", "context", "browser"]);
});

test("captureApiProfileFromBrowser 捕获 detail 请求 headers 和上下文 Cookie", async () => {
  let responseHandler;
  const fakeChromium = {
    async launch() {
      return {
        async newContext() {
          return {
            async newPage() {
              return {
                on(event, handler) {
                  if (event === "response") {
                    responseHandler = handler;
                  }
                },
                async goto() {
                  await responseHandler({
                    url: () => "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=111&webid=web-1",
                    headers: () => ({ "content-type": "application/json" }),
                    request: () => ({
                      async allHeaders() {
                        return {
                          "user-agent": "Mozilla/5.0 Seed Chrome/125.0.0.0",
                          accept: "application/json",
                          "accept-language": "zh-CN,zh;q=0.9",
                          referer: "https://www.douyin.com/video/111",
                          uifid: "seed-uifid",
                          cookie: "sessionid=request-cookie"
                        };
                      }
                    })
                  });
                },
                async waitForTimeout() {},
                async close() {}
              };
            },
            async cookies() {
              return [
                { name: "sessionid", value: "seed-session", domain: ".douyin.com" },
                { name: "ttwid", value: "seed-ttwid", domain: ".douyin.com" },
                { name: "other", value: "ignore", domain: ".example.com" }
              ];
            },
            async close() {}
          };
        },
        async close() {}
      };
    }
  };

  const profile = await captureApiProfileFromBrowser("https://www.douyin.com/video/111", {
    chromium: fakeChromium,
    executablePath: "C:\\fake\\chrome.exe",
    waitAfterLoadMs: 1
  });

  assert.equal(profile.requestHeaders.uifid, "seed-uifid");
  assert.equal(profile.requestHeaders.cookie, undefined);
  assert.equal(profile.cookieHeader, "sessionid=seed-session; ttwid=seed-ttwid");
});

test("captureApiProfileFromBrowser 未捕获 detail API 时仍关闭 page、context 和 browser", async () => {
  const closed = [];
  const fakeChromium = {
    async launch() {
      return {
        async newContext() {
          return {
            async newPage() {
              return {
                on() {},
                async goto() {},
                async waitForTimeout() {},
                async close() {
                  closed.push("page");
                }
              };
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
  };

  await assert.rejects(
    () => captureApiProfileFromBrowser("https://www.douyin.com/video/123", {
      chromium: fakeChromium,
      executablePath: "C:\\fake\\chrome.exe",
      waitAfterLoadMs: 1
    }),
    /未捕获到 detail API JSON 请求/
  );

  assert.deepEqual(closed, ["page", "context", "browser"]);
});
