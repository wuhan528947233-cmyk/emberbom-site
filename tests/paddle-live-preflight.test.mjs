import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyPaddleHost,
  resolvePaddleRuntime,
  resolvePaddleWebhookRuntime,
} from "../functions/_lib/paddle-runtime.mjs";

const PRODUCT_ID = `pro_${"p".repeat(26)}`;
const PRICE_ID = `pri_${"p".repeat(26)}`;
const DATABASE = { prepare() {} };
const PREVIEW_HOST = "codex-t055-paddle-live-preflight.emberbom-site.pages.dev";
const configEndpointSource = readFileSync(new URL("../functions/api/paddle-config.js", import.meta.url), "utf8")
  .replace("../_lib/paddle-runtime.mjs", new URL("../functions/_lib/paddle-runtime.mjs", import.meta.url).href);
const { onRequest: paddleConfig } = await import(
  `data:text/javascript;base64,${Buffer.from(configEndpointSource).toString("base64")}`
);

function environment(kind, overrides = {}) {
  const sandbox = kind === "sandbox";
  return {
    PADDLE_ENVIRONMENT: kind,
    PADDLE_CLIENT_SIDE_TOKEN: `${sandbox ? "test" : "live"}_${"t".repeat(24)}`,
    PADDLE_PRODUCT_ID: PRODUCT_ID,
    PADDLE_PRICE_ID: PRICE_ID,
    PADDLE_LIVE_CHECKOUT_ENABLED: sandbox ? "false" : "true",
    PADDLE_WEBHOOK_SECRET: "notification-secret-for-tests",
    LICENSE_DB: DATABASE,
    ...overrides,
  };
}

test("Preview accepts only Sandbox configuration", () => {
  assert.equal(classifyPaddleHost(PREVIEW_HOST), "preview");
  assert.equal(resolvePaddleRuntime(PREVIEW_HOST, environment("sandbox")).status, "ready");
  assert.equal(resolvePaddleRuntime(PREVIEW_HOST, environment("live")).status, "misconfigured");
});

test("Production accepts only Live configuration after the strict switch is true", () => {
  assert.equal(classifyPaddleHost("emberbom.com"), "production");
  assert.equal(resolvePaddleRuntime("emberbom.com", environment("live")).status, "ready");
  assert.equal(resolvePaddleRuntime("emberbom.com", environment("sandbox", {
    PADDLE_LIVE_CHECKOUT_ENABLED: "true",
  })).status, "misconfigured");
});

test("Production checkout defaults closed and only exact true enables it", () => {
  for (const value of [undefined, "", "false", "TRUE", "1", true]) {
    const runtime = resolvePaddleRuntime("emberbom.com", environment("live", {
      PADDLE_LIVE_CHECKOUT_ENABLED: value,
    }));
    assert.equal(runtime.status, "disabled");
  }
});

test("Missing Production D1, token, product, or price fails closed", () => {
  for (const key of ["LICENSE_DB", "PADDLE_CLIENT_SIDE_TOKEN", "PADDLE_PRODUCT_ID", "PADDLE_PRICE_ID"]) {
    assert.equal(resolvePaddleRuntime("emberbom.com", environment("live", { [key]: undefined })).status, "misconfigured");
  }
});

test("Unapproved hosts cannot obtain either environment", () => {
  for (const host of ["www.emberbom.com", "emberbom-site.pages.dev", "example.com", "preview.example.com"]) {
    assert.equal(classifyPaddleHost(host), null);
    assert.equal(resolvePaddleRuntime(host, environment("live")).status, "not_found");
  }
});

test("Webhook runtime requires a database and secret without exposing either", () => {
  assert.equal(resolvePaddleWebhookRuntime(PREVIEW_HOST, environment("sandbox")).status, "ready");
  assert.equal(resolvePaddleWebhookRuntime(PREVIEW_HOST, environment("sandbox", {
    PADDLE_WEBHOOK_SECRET: undefined,
  })).status, "misconfigured");
  assert.equal(resolvePaddleWebhookRuntime(PREVIEW_HOST, environment("sandbox", {
    LICENSE_DB: undefined,
  })).status, "misconfigured");
});

test("Checkout configuration endpoint fails closed for disabled, invalid, and incomplete Production", async () => {
  let response = paddleConfig({
    request: new Request("https://emberbom.com/api/paddle-config"),
    env: environment("live", { PADDLE_LIVE_CHECKOUT_ENABLED: "false" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false });

  response = paddleConfig({
    request: new Request("https://www.emberbom.com/api/paddle-config"),
    env: environment("live"),
  });
  assert.equal(response.status, 404);

  response = paddleConfig({
    request: new Request("https://emberbom.com/api/paddle-config"),
    env: environment("live", { LICENSE_DB: undefined }),
  });
  assert.equal(response.status, 503);
});

test("Ready checkout configuration exposes only browser-safe identifiers", async () => {
  const response = paddleConfig({
    request: new Request(`https://${PREVIEW_HOST}/api/paddle-config`),
    env: environment("sandbox"),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.enabled, true);
  assert.equal(body.environment, "sandbox");
  assert.equal(body.productId, PRODUCT_ID);
  assert.equal(body.priceId, PRICE_ID);
  assert.equal("webhookSecret" in body, false);
  assert.equal("database" in body, false);
});

test("Wrangler keeps Preview Sandbox and Production Live bindings separate and disabled", () => {
  const source = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const production = source.match(/\[env\.production\.vars\]([\s\S]*?)\[env\.preview\.vars\]/)?.[1] || "";
  const preview = source.match(/\[env\.preview\.vars\]([\s\S]*)$/)?.[1] || "";
  assert.match(production, /PADDLE_ENVIRONMENT = "live"/);
  assert.match(production, /PADDLE_LIVE_CHECKOUT_ENABLED = "false"/);
  assert.match(production, /database_name = "emberbom-licenses-production"/);
  assert.match(production, /binding = "DOWNLOAD_METRICS_DB"/);
  assert.match(production, /database_name = "emberbom-download-metrics"/);
  assert.doesNotMatch(production, /emberbom-download-metrics-preview/);
  assert.doesNotMatch(production, /emberbom-licenses-sandbox|test_|pri_[a-z\d]{26}|pro_[a-z\d]{26}/);
  assert.match(preview, /PADDLE_ENVIRONMENT = "sandbox"/);
  assert.match(preview, /PADDLE_LIVE_CHECKOUT_ENABLED = "false"/);
  assert.match(preview, /PADDLE_CLIENT_SIDE_TOKEN = "test_8948b1d34503e066d8470105d6d"/);
  assert.match(preview, /PADDLE_PRODUCT_ID = "pro_01kxw40xxjvhpz5v9b14tca6he"/);
  assert.match(preview, /PADDLE_PRICE_ID = "pri_01kxw46v5y5m181arczqex1gw8"/);
  assert.match(preview, /database_name = "emberbom-licenses-sandbox"/);
  assert.match(preview, /binding = "DOWNLOAD_METRICS_DB"/);
  assert.match(preview, /database_name = "emberbom-download-metrics-preview"/);
  assert.doesNotMatch(preview, /emberbom-licenses-production|live_/);
});

test("Browser code reads runtime configuration and has no credential fallback", () => {
  const source = readFileSync(new URL("../paddle-sandbox.js", import.meta.url), "utf8");
  assert.match(source, /fetch\("\/api\/paddle-config"/);
  assert.match(source, /config\.environment === "sandbox"/);
  assert.match(source, /Paddle\.Environment\.set\("sandbox"\)/);
  assert.doesNotMatch(source, /Environment\.set\("production"\)|test_[a-zA-Z\d]{20,}|live_[a-zA-Z\d]{20,}|pri_[a-z\d]{26}|pro_[a-z\d]{26}/);
});
