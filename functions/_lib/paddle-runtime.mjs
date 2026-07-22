export const OFFER_IDENTIFIER = "emberbom_founding_team_v1";

const PRODUCTION_HOST = "emberbom.com";
const PAGES_HOST = "emberbom-site.pages.dev";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const PRODUCT_ID = /^pro_[a-z\d]{26}$/;
const PRICE_ID = /^pri_[a-z\d]{26}$/;
const SANDBOX_TOKEN = /^test_[a-zA-Z\d]{20,}$/;
const LIVE_TOKEN = /^live_[a-zA-Z\d]{20,}$/;

function normalizedHost(hostname) {
  return typeof hostname === "string" ? hostname.trim().toLowerCase() : "";
}

export function classifyPaddleHost(hostname) {
  const host = normalizedHost(hostname);
  if (host === PRODUCTION_HOST) {
    return "production";
  }
  if (
    LOCAL_HOSTS.has(host) ||
    (host.endsWith(`.${PAGES_HOST}`) && host !== PAGES_HOST)
  ) {
    return "preview";
  }
  return null;
}

function databaseConfigured(database) {
  return Boolean(database && typeof database.prepare === "function");
}

function validCatalog(environment, env) {
  const tokenPattern = environment === "sandbox" ? SANDBOX_TOKEN : LIVE_TOKEN;
  return (
    tokenPattern.test(env.PADDLE_CLIENT_SIDE_TOKEN || "") &&
    PRODUCT_ID.test(env.PADDLE_PRODUCT_ID || "") &&
    PRICE_ID.test(env.PADDLE_PRICE_ID || "")
  );
}

export function resolvePaddleRuntime(hostname, env = {}) {
  const hostKind = classifyPaddleHost(hostname);
  if (!hostKind) {
    return { status: "not_found" };
  }

  const environment = hostKind === "production" ? "live" : "sandbox";
  if (hostKind === "production" && env.PADDLE_LIVE_CHECKOUT_ENABLED !== "true") {
    return { status: "disabled", environment };
  }

  if (
    env.PADDLE_ENVIRONMENT !== environment ||
    !validCatalog(environment, env) ||
    !databaseConfigured(env.LICENSE_DB)
  ) {
    return { status: "misconfigured", environment };
  }

  return {
    status: "ready",
    environment,
    clientSideToken: env.PADDLE_CLIENT_SIDE_TOKEN,
    productId: env.PADDLE_PRODUCT_ID,
    priceId: env.PADDLE_PRICE_ID,
    offerIdentifier: OFFER_IDENTIFIER,
    database: env.LICENSE_DB,
  };
}

export function resolvePaddleWebhookRuntime(hostname, env = {}) {
  const runtime = resolvePaddleRuntime(hostname, env);
  if (runtime.status !== "ready") {
    return runtime;
  }
  if (typeof env.PADDLE_WEBHOOK_SECRET !== "string" || env.PADDLE_WEBHOOK_SECRET.length < 8) {
    return { status: "misconfigured", environment: runtime.environment };
  }
  return { ...runtime, webhookSecret: env.PADDLE_WEBHOOK_SECRET };
}
