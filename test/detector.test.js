import test from "node:test";
import assert from "node:assert/strict";
import {
  isDetailApiUrl,
  recordApiParseError,
  shouldCaptureDetailResponseJson
} from "../src/detector.js";

test("detail API url matching does not accept broad note or bare detail paths", () => {
  assert.equal(isDetailApiUrl("https://www.douyin.com/note/abc"), false);
  assert.equal(isDetailApiUrl("https://www.douyin.com/api/detail/config"), false);
  assert.equal(isDetailApiUrl("https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123"), true);
});

test("ordinary JSON is not captured as detail response while structured work JSON is captured", () => {
  assert.equal(
    shouldCaptureDetailResponseJson("https://www.douyin.com/api/common/config", {
      id: "site-config",
      desc: "ordinary json payload"
    }),
    false
  );

  assert.equal(
    shouldCaptureDetailResponseJson("https://www.douyin.com/api/common/config", {
      aweme_detail: {
        aweme_id: "123",
        statistics: { digg_count: 1 },
        video: { play_addr: { url_list: ["https://example.com/video.mp4"] } }
      }
    }),
    true
  );
});

test("候选响应 JSON 解析失败只记录到非致命字段，不写入 fatal error", () => {
  const result = {
    error: "",
    apiParseErrors: [],
    debugMessages: []
  };

  recordApiParseError(
    result,
    "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123",
    new Error("response.json: Target page, context or browser has been closed")
  );

  assert.equal(result.error, "");
  assert.equal(result.apiParseErrors.length, 1);
  assert.equal(result.apiParseErrors[0].url, "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123");
  assert.match(result.apiParseErrors[0].message, /候选 JSON 响应解析失败/);
  assert.equal(result.debugMessages.length, 1);
});
