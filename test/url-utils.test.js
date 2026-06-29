import test from "node:test";
import assert from "node:assert/strict";
import { extractDouyinWorkInfo, isSupportedDouyinUrl } from "../src/url-utils.js";

test("extractDouyinWorkInfo 识别 video 链接", () => {
  assert.deepEqual(extractDouyinWorkInfo("https://www.douyin.com/video/7646781280897958638"), {
    supported: true,
    type: "视频",
    pathType: "video",
    workId: "7646781280897958638"
  });
});

test("extractDouyinWorkInfo 识别 note 链接", () => {
  assert.deepEqual(extractDouyinWorkInfo("https://www.douyin.com/note/7336500551691062538"), {
    supported: true,
    type: "图文",
    pathType: "note",
    workId: "7336500551691062538"
  });
});

test("extractDouyinWorkInfo 识别 share video 链接", () => {
  assert.equal(
    extractDouyinWorkInfo("https://www.douyin.com/share/video/7653287940747508965").workId,
    "7653287940747508965"
  );
});

test("extractDouyinWorkInfo 保留查询参数前的作品 ID", () => {
  assert.equal(
    extractDouyinWorkInfo("https://www.douyin.com/video/7646781280897958638?previous_page=app_code_link").workId,
    "7646781280897958638"
  );
});

test("isSupportedDouyinUrl 拒绝非抖音作品链接", () => {
  assert.equal(isSupportedDouyinUrl("https://example.com/video/123"), false);
  assert.equal(extractDouyinWorkInfo("https://example.com/video/123").supported, false);
});

test("extractDouyinWorkInfo 拒绝缺少作品 ID 的链接", () => {
  assert.deepEqual(extractDouyinWorkInfo("https://www.douyin.com/video/"), {
    supported: false,
    type: "未知",
    pathType: "unknown",
    workId: ""
  });
});

test("extractDouyinWorkInfo 拒绝作品 ID 后继续追加路径段的链接", () => {
  assert.equal(extractDouyinWorkInfo("https://www.douyin.com/video/123/extra").supported, false);
  assert.equal(extractDouyinWorkInfo("https://www.douyin.com/note/abc/anything").supported, false);
});
