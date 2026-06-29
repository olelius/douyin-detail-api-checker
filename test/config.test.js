import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_API_OPTIONS,
  DEFAULT_FALLBACK_OPTIONS,
  DEFAULT_UI_SERVICE,
  getUiServiceConfig
} from "../src/config.js";

test("UI 服务默认监听 3000 且不静默切换端口", () => {
  assert.equal(DEFAULT_UI_SERVICE.host, "127.0.0.1");
  assert.equal(DEFAULT_UI_SERVICE.port, 3000);
  assert.equal(DEFAULT_UI_SERVICE.openBrowser, true);
});

test("两阶段检测默认并发符合设计文档", () => {
  assert.equal(DEFAULT_API_OPTIONS.concurrency, 5);
  assert.equal(DEFAULT_API_OPTIONS.delayMs, 1000);
  assert.equal(DEFAULT_API_OPTIONS.timeoutMs, 15000);
  assert.equal(DEFAULT_FALLBACK_OPTIONS.concurrency, 2);
  assert.equal(DEFAULT_FALLBACK_OPTIONS.delayMs, 1000);
  assert.equal(DEFAULT_FALLBACK_OPTIONS.timeoutMs, 15000);
  assert.equal(DEFAULT_FALLBACK_OPTIONS.waitAfterLoadMs, 6000);
});

test("getUiServiceConfig 支持环境变量覆盖但保持数字校验", () => {
  const config = getUiServiceConfig({ UI_PORT: "3000", UI_HOST: "127.0.0.1" });
  assert.deepEqual(config, {
    host: "127.0.0.1",
    port: 3000,
    openBrowser: true
  });
});

test("getUiServiceConfig 拒绝非法端口", () => {
  assert.throws(
    () => getUiServiceConfig({ UI_PORT: "abc" }),
    /UI_PORT 必须是 1 到 65535 之间的整数/
  );
});

test("getUiServiceConfig 只允许本地 loopback 地址", () => {
  assert.equal(getUiServiceConfig({ UI_HOST: "127.0.0.1" }).host, "127.0.0.1");
  assert.throws(
    () => getUiServiceConfig({ UI_HOST: "0.0.0.0" }),
    /UI_HOST 只允许使用本地地址 127\.0\.0\.1/
  );
});
