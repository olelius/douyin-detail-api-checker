import test from "node:test";
import assert from "node:assert/strict";
import { classifyDetailResult } from "../src/classifier.js";

test("detail API 有视频数据时判定为视频存活", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/video/123",
    finalUrl: "https://www.douyin.com/video/123",
    apiUrl: "https://www.douyin.com/aweme/v1/web/aweme/detail/",
    detailJson: {
      aweme_detail: {
        aweme_id: "123",
        desc: "测试视频",
        video: { play_addr: { url_list: ["https://example.com/video.mp4"] } },
        statistics: { digg_count: 1 }
      }
    }
  });

  assert.equal(result.status, "存活");
  assert.equal(result.contentType, "视频");
  assert.equal(result.basis, "detail_api");
});

test("detail API 返回空作品和错误信息时判定为失效", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/video/404",
    finalUrl: "https://www.douyin.com/video/404",
    detailJson: {
      aweme_detail: null,
      status_code: 8,
      status_msg: "作品不存在"
    }
  });

  assert.equal(result.status, "失效");
  assert.equal(result.contentType, "视频");
  assert.equal(result.basis, "detail_api");
});

test("detail API 有图文字段时判定为图文存活", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/note/abc",
    finalUrl: "https://www.douyin.com/note/abc",
    detailJson: {
      aweme_detail: {
        aweme_id: "abc",
        desc: "测试图文",
        images: [{ url_list: ["https://example.com/1.jpg"] }]
      }
    }
  });

  assert.equal(result.status, "存活");
  assert.equal(result.contentType, "图文");
  assert.equal(result.basis, "detail_api");
});

test("视频链接跳转到图文且有存活证据时说明跳转原因", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/video/123",
    finalUrl: "https://www.douyin.com/note/123",
    detailJson: {
      aweme_detail: {
        aweme_id: "123",
        image_post_info: { images: [{ uri: "x" }] }
      }
    }
  });

  assert.equal(result.status, "存活");
  assert.equal(result.contentType, "图文");
  assert.equal(result.basis, "url_redirect");
  assert.match(result.reason, /视频链接跳转图文/);
});

test("DOM 文本包含存活关键词时兜底判定为存活", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/note/abc",
    finalUrl: "https://www.douyin.com/note/abc",
    fallbackText: "作者 关注 点赞 评论 发布时间"
  });

  assert.equal(result.status, "存活");
  assert.equal(result.contentType, "图文");
  assert.equal(result.basis, "dom_text");
});

test("DOM 文本包含图文不存在时兜底判定为图文失效", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/note/404",
    finalUrl: "https://www.douyin.com/note/404",
    fallbackText: "你要观看的图文不存在"
  });

  assert.equal(result.status, "失效");
  assert.equal(result.contentType, "图文");
  assert.equal(result.basis, "dom_text");
});

test("出现登录或验证码文案时判定为待确认", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/video/123",
    finalUrl: "https://www.douyin.com/video/123",
    fallbackText: "请完成验证码后继续访问"
  });

  assert.equal(result.status, "待确认");
  assert.equal(result.contentType, "视频");
  assert.equal(result.basis, "heuristic");
});

test("采集错误时判定为待确认并保留错误依据", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/video/123",
    error: "页面打开超时"
  });

  assert.equal(result.status, "待确认");
  assert.equal(result.basis, "error");
  assert.match(result.reason, /页面打开超时/);
});

test("detail API 空作品且 filter_detail.detail_msg 为删除权限文案时判定为失效", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/video/404",
    finalUrl: "https://www.douyin.com/video/404",
    detailJson: {
      aweme_detail: null,
      status_code: 0,
      filter_detail: {
        detail_msg: "视频已删除或因权限不可见"
      }
    }
  });

  assert.equal(result.status, "失效");
  assert.equal(result.contentType, "视频");
  assert.equal(result.basis, "detail_api");
  assert.match(result.reason, /删除|权限|不可见/);
});

test("detail API 空作品且真实权限删除文案时判定为视频失效", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/video/7646781280897958638",
    finalUrl: "https://www.douyin.com/video/7646781280897958638",
    detailJson: {
      aweme_detail: null,
      status_code: 0,
      filter_detail: {
        aweme_id: "7646781280897958638",
        detail_msg: "因作品权限或已被删除，无法观看，去看看其他作品吧",
        filter_reason: "status_self_see"
      }
    }
  });

  assert.equal(result.status, "失效");
  assert.equal(result.contentType, "视频");
  assert.equal(result.basis, "detail_api");
  assert.match(result.reason, /权限|已删除/);
});

test("HTTP API 返回登录或风控文案时保持待确认", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/video/123",
    finalUrl: "https://www.douyin.com/video/123",
    detailJson: {
      status_code: 2149,
      status_msg: "请先登录后继续访问"
    }
  });

  assert.equal(result.status, "待确认");
  assert.equal(result.contentType, "视频");
  assert.equal(result.basis, "detail_api");
});

test("候选 detail JSON 解析失败不覆盖 DOM 失效兜底判定", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/video/404",
    finalUrl: "https://www.douyin.com/video/404",
    fallbackText: "你要观看的视频不存在",
    error: "detail API 响应 JSON 解析失败：response.json: Target page, context or browser has been closed",
    apiParseErrors: [
      "detail API 响应 JSON 解析失败：response.json: Target page, context or browser has been closed"
    ]
  });

  assert.equal(result.status, "失效");
  assert.equal(result.contentType, "视频");
  assert.equal(result.basis, "dom_text");
});

test("apiParseErrors 为对象数组时也不覆盖 DOM 失效兜底判定", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/note/404",
    finalUrl: "https://www.douyin.com/note/404",
    fallbackText: "你要观看的图文不存在",
    error: "detail API 响应 JSON 解析失败：response.json: Protocol error (Network.getResponseBody): No resource with given identifier found",
    apiParseErrors: [
      {
        url: "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=404",
        message: "候选 JSON 响应解析失败：response.json: Protocol error (Network.getResponseBody): No resource with given identifier found"
      }
    ]
  });

  assert.equal(result.status, "失效");
  assert.equal(result.contentType, "图文");
  assert.equal(result.basis, "dom_text");
});

test("ordinary JSON with only id and desc is not classified as alive", () => {
  const result = classifyDetailResult({
    originalUrl: "https://www.douyin.com/video/123",
    finalUrl: "https://www.douyin.com/video/123",
    apiUrl: "https://www.douyin.com/api/common/config",
    detailJson: {
      id: "site-config",
      desc: "ordinary json payload"
    }
  });

  assert.notEqual(result.status, "存活");
  assert.equal(result.basis, "heuristic");
});
