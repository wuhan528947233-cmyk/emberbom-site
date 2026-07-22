(function () {
  "use strict";

  const OFFER_IDENTIFIER = "emberbom_founding_team_v1";
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
  const PAGES_HOST = "emberbom-site.pages.dev";
  const PRODUCTION_HOST = "emberbom.com";
  const PRODUCT_ID = /^pro_[a-z\d]{26}$/;
  const PRICE_ID = /^pri_[a-z\d]{26}$/;
  const SANDBOX_TOKEN = /^test_[a-zA-Z\d]{20,}$/;
  const LIVE_TOKEN = /^live_[a-zA-Z\d]{20,}$/;

  function setStatus(message) {
    const status = document.getElementById("purchase-status");
    if (status) status.textContent = message;
  }

  function showFallback(message) {
    const interest = document.getElementById("purchase-interest");
    const button = document.getElementById("paddle-sandbox-checkout");
    const notice = document.getElementById("sandbox-mode-notice");
    const fields = document.getElementById("sandbox-licensee-fields");
    if (interest) interest.hidden = false;
    if (button) {
      button.hidden = true;
      button.disabled = true;
    }
    if (notice) notice.hidden = true;
    if (fields) fields.hidden = true;
    setStatus(message);
  }

  function hostSupportsEnvironment(hostname, environment) {
    const host = String(hostname || "").toLowerCase();
    if (environment === "live") return host === PRODUCTION_HOST;
    return environment === "sandbox" &&
      (LOCAL_HOSTS.has(host) || (host.endsWith(`.${PAGES_HOST}`) && host !== PAGES_HOST));
  }

  function validConfig(config, hostname) {
    if (!config || config.enabled !== true || !hostSupportsEnvironment(hostname, config.environment)) {
      return false;
    }
    const tokenPattern = config.environment === "sandbox" ? SANDBOX_TOKEN : LIVE_TOKEN;
    return tokenPattern.test(config.clientSideToken || "") &&
      PRODUCT_ID.test(config.productId || "") &&
      PRICE_ID.test(config.priceId || "") &&
      config.offerIdentifier === OFFER_IDENTIFIER;
  }

  function normalizeLicenseeName(value) {
    const normalized = String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
    if (normalized.length < 2 || normalized.length > 120 ||
      !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} .,'’()\-_/]{1,119}$/u.test(normalized)) {
      return null;
    }
    return normalized;
  }

  function getLicenseeData(config) {
    const nameInput = document.getElementById("sandbox-licensee-name");
    const authorityInput = document.getElementById("sandbox-licensee-authority");
    const error = document.getElementById("sandbox-licensee-error");
    const licenseeName = normalizeLicenseeName(nameInput?.value);
    if (!licenseeName || !authorityInput?.checked) {
      error.textContent = !licenseeName
        ? "Enter a valid legal organization name (2–120 characters)."
        : "Confirm that you are authorized to purchase for this organization.";
      error.hidden = false;
      return null;
    }
    error.hidden = true;
    return { licensee_name: licenseeName, offer_identifier: config.offerIdentifier };
  }

  function showLocalizedPrice(result, config) {
    const lineItem = result?.data?.details?.lineItems?.[0];
    const price = lineItem?.price;
    const localizedTotal = lineItem?.formattedTotals?.total;
    if (!lineItem || lineItem.quantity !== 1 || price?.id !== config.priceId ||
      lineItem.product?.id !== config.productId || lineItem.product?.name !== "EmberBOM" ||
      price?.billingCycle !== null || price?.unitPrice?.amount !== "9900" ||
      price?.unitPrice?.currencyCode !== "USD") {
      throw new Error("catalog_mismatch");
    }
    if (typeof localizedTotal === "string" && localizedTotal.trim()) {
      document.getElementById("purchase-price-symbol").textContent = "";
      document.getElementById("purchase-price-total").textContent = localizedTotal;
      document.getElementById("purchase-price-note").textContent = "one-time";
    }
  }

  function handlePaddleEvent(event, environment) {
    if (!event || typeof event.name !== "string") return;
    if (event.name === "checkout.completed") {
      const transactionId = event.data?.transaction_id || event.data?.transactionId;
      if (environment === "sandbox") {
        setStatus(/^txn_[a-z0-9]+$/i.test(transactionId || "")
          ? `Sandbox checkout completed. Test transaction: ${transactionId}. Fulfillment is pending the verified Sandbox webhook.`
          : "Sandbox checkout completed, but no valid test transaction ID was returned.");
      } else {
        setStatus("Payment was completed. License fulfillment is pending Paddle's verified webhook; keep your Paddle receipt.");
      }
    } else if (["checkout.error", "checkout.payment.error", "checkout.payment.failed"].includes(event.name)) {
      setStatus("Payment was not completed and no license was issued. You may retry or close checkout.");
    }
  }

  function loadPaddle() {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("paddle_script_load_failed"));
      document.head.appendChild(script);
    });
  }

  async function fetchCheckoutConfig() {
    const response = await fetch("/api/paddle-config", {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("checkout_config_unavailable");
    return response.json();
  }

  async function initializeCheckout() {
    let config;
    try {
      config = await fetchCheckoutConfig();
    } catch {
      showFallback("Paid checkout is not currently available. The free evaluation download remains available.");
      return;
    }
    if (config?.enabled !== true) {
      showFallback("Paid checkout is not currently enabled. The free evaluation download remains available.");
      return;
    }
    if (!validConfig(config, window.location.hostname)) {
      showFallback("Checkout configuration was rejected for this host. No payment was attempted.");
      return;
    }

    const interest = document.getElementById("purchase-interest");
    const button = document.getElementById("paddle-sandbox-checkout");
    const notice = document.getElementById("sandbox-mode-notice");
    const fields = document.getElementById("sandbox-licensee-fields");
    interest.hidden = true;
    button.hidden = false;
    notice.hidden = config.environment !== "sandbox";
    fields.hidden = false;
    button.textContent = config.environment === "sandbox" ? "Test checkout" : "Buy with Paddle";
    setStatus(config.environment === "sandbox" ? "Loading Paddle Sandbox pricing…" : "Loading Paddle pricing…");

    try {
      await loadPaddle();
      if (!validConfig(config, window.location.hostname) || !window.Paddle) {
        throw new Error("host_or_library_invalid");
      }
      if (config.environment === "sandbox") window.Paddle.Environment.set("sandbox");
      window.Paddle.Initialize({
        token: config.clientSideToken,
        eventCallback: (event) => handlePaddleEvent(event, config.environment),
      });
      showLocalizedPrice(await window.Paddle.PricePreview({
        items: [{ priceId: config.priceId, quantity: 1 }],
      }), config);
      button.disabled = false;
      setStatus(config.environment === "sandbox"
        ? "Paddle Sandbox is ready. Test checkout cannot take a real payment."
        : "Paddle checkout is ready. Taxes are calculated by Paddle based on location.");
      button.addEventListener("click", () => {
        if (!validConfig(config, window.location.hostname)) {
          showFallback("Checkout was blocked because this host or environment is not approved.");
          return;
        }
        const customData = getLicenseeData(config);
        if (customData) {
          window.Paddle.Checkout.open({
            items: [{ priceId: config.priceId, quantity: 1 }],
            customData,
          });
        }
      });
    } catch (error) {
      showFallback(error?.message === "catalog_mismatch"
        ? "Paddle catalog validation failed. Checkout is disabled because the product or price does not match the EmberBOM offer."
        : "Paddle checkout could not load. Checkout is disabled and no payment was attempted.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeCheckout, { once: true });
  } else {
    initializeCheckout();
  }
})();
