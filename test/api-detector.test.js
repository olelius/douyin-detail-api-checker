import test from "node:test";
import assert from "node:assert/strict";
import { buildDetailApiCandidates, createApiDetector, isRiskApiPayload } from "../src/api-detector.js";
import { extractApiProfileFromUrl } from "../src/api-profile-cache.js";

test("buildDetailApiCandidates 为作品 ID 生成明确 detail API 候选地址", () => {
  const urls = buildDetailApiCandidates({ workId: "123", pathType: "video" });

  assert.ok(urls.some((url) => url.includes("aweme/v1/web/aweme/detail")));
  assert.ok(urls.some((url) => url.includes("aweme/v1/web/multi/aweme/detail")));
  assert.ok(urls.some((url) => url.includes("aweme/v1/web/note/detail")));
  assert.ok(urls.every((url) => url.includes("aweme_id=123") || url.includes("item_id=123") || url.includes("aweme_ids=%5B123%5D")));
});

test("createApiDetector 注入 Cookie 和真实 UA 并返回结构化证据", async () => {
  const calls = [];
  const detector = createApiDetector({
    cookieHeader: "sessionid=abc;",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        aweme_detail: {
          aweme_id: "123",
          desc: "测试视频",
          video: { play_addr: { url_list: ["https://example.test/v.mp4"] } },
          statistics: { digg_count: 1 }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const evidence = await detector.detect("https://www.douyin.com/video/123");

  assert.equal(evidence.stage, "api");
  assert.equal(evidence.originalUrl, "https://www.douyin.com/video/123");
  assert.equal(evidence.finalUrl, "https://www.douyin.com/video/123");
  assert.equal(evidence.detailJson.aweme_detail.aweme_id, "123");
  assert.equal(evidence.needsFallback, false);
  assert.match(calls[0].options.headers.cookie, /sessionid=abc/);
  assert.match(calls[0].options.headers["user-agent"], /Chrome/);
});

test("createApiDetector 遇到不支持 URL 返回待兜底证据且不访问网络", async () => {
  const detector = createApiDetector({ fetchImpl: async () => assert.fail("不应访问网络") });
  const evidence = await detector.detect("https://example.com/a");

  assert.equal(evidence.needsFallback, true);
  assert.equal(evidence.errorType, "unsupported_url");
  assert.match(evidence.error, /不属于支持的抖音作品链接/);
});

test("createApiDetector 遇到 HTTP 异常时隐藏 Cookie 明文并进入兜底", async () => {
  const detector = createApiDetector({
    cookieHeader: "sessionid=secret-cookie;",
    fetchImpl: async () => new Response("server error", { status: 500 })
  });

  const evidence = await detector.detect("https://www.douyin.com/video/123");

  assert.equal(evidence.needsFallback, true);
  assert.equal(evidence.errorType, "http_status");
  assert.match(evidence.error, /HTTP 状态码 500/);
  assert.doesNotMatch(evidence.error, /secret-cookie/);
});

test("createApiDetector 首个候选失败后继续尝试后续候选并成功", async () => {
  const calls = [];
  const detector = createApiDetector({
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        return new Response("not found", { status: 404 });
      }

      return new Response(JSON.stringify({
        aweme_list: [{
          aweme_id: "123",
          desc: "后续候选成功",
          video: { play_addr: { url_list: ["https://example.test/v.mp4"] } }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const evidence = await detector.detect("https://www.douyin.com/video/123");

  assert.equal(calls.length, 2);
  assert.equal(evidence.needsFallback, false);
  assert.equal(evidence.detailJson.aweme_list[0].aweme_id, "123");
  assert.match(evidence.apiUrl, /multi\/aweme\/detail/);
});

test("createApiDetector 有画像时优先使用画像候选，失败后回退旧候选", async () => {
  const calls = [];
  const profile = extractApiProfileFromUrl(
    "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=111&webid=web-1",
    { capturedAt: 1000, ttlMs: 600000, sourceWorkId: "111" }
  );
  const detector = createApiDetector({
    apiProfile: profile,
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        return new Response("profile failed", { status: 404 });
      }
      return new Response(JSON.stringify({
        aweme_detail: {
          aweme_id: "222",
          desc: "旧候选回退成功",
          video: { play_addr: { url_list: ["https://example.test/v.mp4"] } }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const evidence = await detector.detect("https://www.douyin.com/video/222");

  assert.match(calls[0], /webid=web-1/);
  assert.match(calls[0], /aweme_id=222/);
  assert.match(calls[1], /aweme\/detail\/\?aweme_id=222/);
  assert.equal(evidence.needsFallback, false);
  assert.equal(evidence.apiCacheUsed, true);
  assert.equal(evidence.apiProfileStatus, "ready");
  assert.equal(evidence.apiCandidateSource, "default");
});

test("profile 候选使用画像 headers 和 Cookie，default 候选仍使用配置 Cookie", async () => {
  const calls = [];
  const profile = extractApiProfileFromUrl(
    "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=111&webid=web-1&uifid=query-uifid",
    {
      capturedAt: 1000,
      ttlMs: 600000,
      sourceWorkId: "111",
      requestHeaders: {
        "user-agent": "Mozilla/5.0 Profile Chrome/125.0.0.0",
        accept: "application/json",
        "accept-language": "zh-CN,zh;q=0.9",
        referer: "https://www.douyin.com/video/111",
        uifid: "profile-uifid",
        cookie: "sessionid=ignored-request-cookie"
      },
      cookieHeader: "sessionid=profile-cookie; ttwid=profile-ttwid"
    }
  );
  const detector = createApiDetector({
    apiProfile: profile,
    cookieHeader: "sessionid=config-cookie",
    fetchImpl: async (url, options) => {
      calls.push({ url, headers: options.headers });
      if (calls.length === 1) {
        return new Response("profile failed", { status: 404 });
      }
      return new Response(JSON.stringify({
        aweme_detail: {
          aweme_id: "222",
          desc: "默认候选回退成功",
          video: { play_addr: { url_list: ["https://example.test/v.mp4"] } }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const evidence = await detector.detect("https://www.douyin.com/video/222");

  assert.equal(calls[0].headers.cookie, "sessionid=profile-cookie; ttwid=profile-ttwid");
  assert.equal(calls[0].headers["accept-language"], "zh-CN,zh;q=0.9");
  assert.equal(calls[0].headers.uifid, "profile-uifid");
  assert.equal(calls[1].headers.cookie, "sessionid=config-cookie");
  assert.equal(calls[1].headers.uifid, undefined);
  assert.equal(evidence.needsFallback, false);
  assert.equal(evidence.apiCandidateSource, "default");
});

test("createApiDetector 画像候选命中时保留来源且 apiUrl 不泄露签名值", async () => {
  const profile = extractApiProfileFromUrl(
    "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=111&a_bogus=secret-a&msToken=secret-ms&x-secsdk-web-signature=secret-sign&timestamp=123456&webid=web-1",
    { capturedAt: 1000, ttlMs: 600000, sourceWorkId: "111" }
  );
  const detector = createApiDetector({
    apiProfile: profile,
    fetchImpl: async () => new Response(JSON.stringify({
      aweme_detail: {
        aweme_id: "222",
        desc: "画像候选命中",
        video: { play_addr: { url_list: ["https://example.test/v.mp4"] } }
      }
    }), { status: 200, headers: { "content-type": "application/json" } })
  });

  const evidence = await detector.detect("https://www.douyin.com/video/222");

  assert.equal(evidence.needsFallback, false);
  assert.equal(evidence.apiCandidateSource, "profile");
  assert.deepEqual(evidence.apiCandidateSources, ["profile", "default"]);
  assert.match(evidence.apiUrl, /aweme_id=222/);
  assert.match(evidence.apiUrl, /a_bogus=\*\*\*/);
  assert.match(evidence.apiUrl, /msToken=\*\*\*/);
  assert.match(evidence.apiUrl, /x-secsdk-web-signature=\*\*\*/);
  assert.match(evidence.apiUrl, /timestamp=\*\*\*/);
  assert.doesNotMatch(evidence.apiUrl, /secret-a|secret-ms|secret-sign|123456/);
});

test("createApiDetector 画像生成失败时安全回退旧候选并记录状态", async () => {
  const calls = [];
  const detector = createApiDetector({
    apiProfile: { status: "invalid", endpoint: "", queryParams: [] },
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({
        aweme_detail: {
          aweme_id: "333",
          desc: "旧候选成功",
          video: { play_addr: { url_list: ["https://example.test/v.mp4"] } }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const evidence = await detector.detect("https://www.douyin.com/video/333");

  assert.equal(calls.length, 1);
  assert.match(calls[0], /aweme\/detail\/\?aweme_id=333/);
  assert.equal(evidence.needsFallback, false);
  assert.equal(evidence.apiCacheUsed, false);
  assert.equal(evidence.apiProfileStatus, "invalid");
});

test("createApiDetector 全部候选失败时保留候选来源观测字段", async () => {
  const profile = extractApiProfileFromUrl(
    "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=111&webid=web-1",
    { capturedAt: 1000, ttlMs: 600000, sourceWorkId: "111" }
  );
  const detector = createApiDetector({
    apiProfile: profile,
    fetchImpl: async () => new Response("not found", { status: 404 })
  });

  const evidence = await detector.detect("https://www.douyin.com/video/222");

  assert.equal(evidence.needsFallback, true);
  assert.equal(evidence.apiCandidateSource, "default");
  assert.deepEqual(evidence.apiCandidateSources, ["profile", "default"]);
});

test("createApiDetector 在 fetch 异常中脱敏完整 Cookie 明文", async () => {
  const detector = createApiDetector({
    cookieHeader: "sessionid=secret-cookie; ttwid=secret-ttwid",
    fetchImpl: async () => {
      throw new Error("请求失败 Cookie: sessionid=secret-cookie; ttwid=secret-ttwid");
    }
  });

  const evidence = await detector.detect("https://www.douyin.com/video/123");

  assert.equal(evidence.needsFallback, true);
  assert.doesNotMatch(evidence.error, /secret-cookie/);
  assert.doesNotMatch(evidence.error, /secret-ttwid/);
  assert.match(evidence.error, /sessionid=\*\*\*/);
  assert.match(evidence.error, /ttwid=\*\*\*/);
});

test("createApiDetector 在 fetch 异常和候选失败汇总中脱敏签名 query", async () => {
  const detector = createApiDetector({
    fetchImpl: async (url) => {
      throw new Error(`请求失败 ${url}&a_bogus=secret-a&x-secsdk-web-signature=secret-sign&__ac_signature=secret-ac`);
    }
  });

  const evidence = await detector.detect("https://www.douyin.com/video/123");

  assert.equal(evidence.needsFallback, true);
  assert.equal(evidence.errorType, "request_error");
  assert.doesNotMatch(evidence.error, /secret-a|secret-sign|secret-ac/);
  assert.match(evidence.error, /a_bogus=\*\*\*/);
  assert.match(evidence.error, /x-secsdk-web-signature=\*\*\*/);
  assert.match(evidence.error, /__ac_signature=\*\*\*/);
});

test("createApiDetector 遇到风控响应时标记 needsFallback 而不误判失效", async () => {
  const detector = createApiDetector({
    fetchImpl: async () => new Response(JSON.stringify({ status_code: 2149, status_msg: "请先登录后继续访问" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  });

  const evidence = await detector.detect("https://www.douyin.com/video/123");

  assert.equal(evidence.needsFallback, true);
  assert.equal(evidence.errorType, "risk_control");
  assert.equal(evidence.detailJson.status_code, 2149);
});

test("isRiskApiPayload 识别登录验证码和访问频繁", () => {
  assert.equal(isRiskApiPayload({ status_msg: "请先登录" }), true);
  assert.equal(isRiskApiPayload({ message: "访问过于频繁，请稍后再试" }), true);
  assert.equal(isRiskApiPayload({ status_msg: "作品不存在" }), false);
});

test("isRiskApiPayload 不扫描有效作品普通字段中的风控词片段", () => {
  const payload = {
    aweme_detail: {
      aweme_id: "123",
      desc: "演示 verify 参数和登录页链接文本，但不是错误文案",
      video: {
        play_addr: {
          url_list: [
            "https://example.test/video.mp4?verify=token&redirect=https%3A%2F%2Fexample.test%2Flogin"
          ]
        }
      },
      statistics: { digg_count: 1 },
      token: "login-verify-token"
    }
  };

  assert.equal(isRiskApiPayload(payload), false);
});

test("createApiDetector 对普通字段含风控词的有效作品不进入兜底", async () => {
  const detector = createApiDetector({
    fetchImpl: async () => new Response(JSON.stringify({
      aweme_detail: {
        aweme_id: "123",
        desc: "标题里出现 verify 和登录说明但作品有效",
        video: {
          play_addr: {
            url_list: [
              "https://example.test/video.mp4?verify=token&login=1"
            ]
          }
        },
        statistics: { digg_count: 1 },
        token: "verify-login-token"
      }
    }), { status: 200, headers: { "content-type": "application/json" } })
  });

  const evidence = await detector.detect("https://www.douyin.com/video/123");

  assert.equal(evidence.needsFallback, false);
  assert.equal(evidence.errorType, "");
});
