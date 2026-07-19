(function () {
  "use strict";

  // Browser-safe Paddle Sandbox values. This file must never contain an API key,
  // webhook secret, or live client-side token.
  const SANDBOX_CONFIG = Object.freeze({
    clientSideToken: "test_8948b1d34503e066d8470105d6d",
    priceId: "pri_01kxw46v5y5m181arczqex1gw8",
    quantity: 1,
    offerIdentifier: "emberbom_founding_team_v1",
    previewHosts: Object.freeze([
      "codex-t053-paddle-sandbox-fu.emberbom-site.pages.dev",
    ]),
  });

  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
  const PRODUCTION_HOSTS = new Set([
    "emberbom.com",
    "www.emberbom.com",
    "emberbom-site.pages.dev",
  ]);

  function isAllowedSandboxHost(hostname) {
    return LOCAL_HOSTS.has(hostname) || SANDBOX_CONFIG.previewHosts.includes(hostname);
  }

  function setStatus(message) {
    const status = document.getElementById("purchase-status");
    if (status) {
      status.textContent = message;
    }
  }

  function showFallback(message) {
    const button = document.getElementById("paddle-sandbox-checkout");
    if (button) {
      button.disabled = true;
    }
    setStatus(message);
  }

  function normalizeLicenseeName(value) {
    const normalized = String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ");
    if (
      normalized.length < 2 ||
      normalized.length > 120 ||
      !/^[\p{L}\p{N}][\p{L}\p{N}\p{M} .,'’&()\-_/]{1,119}$/u.test(normalized)
    ) {
      return null;
    }
    return normalized;
  }

  function getLicenseeData() {
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
    return {
      licensee_name: licenseeName,
      offer_identifier: SANDBOX_CONFIG.offerIdentifier,
    };
  }

  function showLocalizedPrice(result) {
    const lineItem = result?.data?.details?.lineItems?.[0];
    const price = lineItem?.price;
    const localizedTotal = lineItem?.formattedTotals?.total;

    if (
      !lineItem ||
      lineItem.quantity !== SANDBOX_CONFIG.quantity ||
      price?.id !== SANDBOX_CONFIG.priceId ||
      lineItem.product?.name !== "EmberBOM" ||
      price?.billingCycle !== null ||
      price?.unitPrice?.amount !== "9900" ||
      price?.unitPrice?.currencyCode !== "USD"
    ) {
      throw new Error("sandbox_catalog_mismatch");
    }

    if (typeof localizedTotal === "string" && localizedTotal.trim() !== "") {
      document.getElementById("purchase-price-symbol").textContent = "";
      document.getElementById("purchase-price-total").textContent = localizedTotal;
      document.getElementById("purchase-price-note").textContent = "one-time";
    }
  }

  function handlePaddleEvent(event) {
    if (!event || typeof event.name !== "string") {
      return;
    }

    if (event.name === "checkout.completed") {
      const transactionId = event.data?.transaction_id || event.data?.transactionId;
      if (/^txn_[a-z0-9]+$/i.test(transactionId || "")) {
        setStatus(
          `Sandbox checkout completed. Test transaction: ${transactionId}. Server-side Sandbox fulfillment is pending the verified Paddle webhook; no real commercial license was issued.`
        );
      } else {
        setStatus(
          "Sandbox checkout completed, but no valid test transaction ID was returned. No real commercial license was issued."
        );
      }
      return;
    }

    if (
      event.name === "checkout.error" ||
      event.name === "checkout.payment.error" ||
      event.name === "checkout.payment.failed"
    ) {
      setStatus(
        "Sandbox payment failed. No purchase was completed and no license was issued. You may retry or close checkout."
      );
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

  async function initializeSandboxCheckout() {
    const hostname = window.location.hostname.toLowerCase();
    if (!isAllowedSandboxHost(hostname)) {
      if (PRODUCTION_HOSTS.has(hostname)) {
        setStatus(
          "Sandbox checkout is disabled on this production host. Live checkout remains unavailable while seller approval is pending. No payment is accepted by email."
        );
      } else {
        setStatus("Sandbox checkout is disabled on this unapproved host.");
      }
      return;
    }

    const purchaseInterest = document.getElementById("purchase-interest");
    const checkoutButton = document.getElementById("paddle-sandbox-checkout");
    const sandboxNotice = document.getElementById("sandbox-mode-notice");
    const licenseeFields = document.getElementById("sandbox-licensee-fields");
    purchaseInterest.hidden = true;
    checkoutButton.hidden = false;
    sandboxNotice.hidden = false;
    licenseeFields.hidden = false;
    setStatus("Loading Paddle Sandbox pricing…");

    try {
      await loadPaddle();
      if (!isAllowedSandboxHost(window.location.hostname.toLowerCase()) || !window.Paddle) {
        throw new Error("sandbox_host_or_library_invalid");
      }

      window.Paddle.Environment.set("sandbox");
      window.Paddle.Initialize({
        token: SANDBOX_CONFIG.clientSideToken,
        eventCallback: handlePaddleEvent,
      });

      const preview = await window.Paddle.PricePreview({
        items: [{ priceId: SANDBOX_CONFIG.priceId, quantity: SANDBOX_CONFIG.quantity }],
      });
      showLocalizedPrice(preview);

      checkoutButton.disabled = false;
      setStatus("Paddle Sandbox is ready. Use Test checkout to make a test transaction; no real payment will be taken.");
      checkoutButton.addEventListener("click", () => {
        if (!isAllowedSandboxHost(window.location.hostname.toLowerCase())) {
          showFallback("Sandbox checkout was blocked because this host is not approved for testing.");
          return;
        }
        const customData = getLicenseeData();
        if (!customData) {
          return;
        }
        window.Paddle.Checkout.open({
          items: [{ priceId: SANDBOX_CONFIG.priceId, quantity: SANDBOX_CONFIG.quantity }],
          customData,
        });
      });
    } catch (error) {
      showFallback(
        error?.message === "sandbox_catalog_mismatch"
          ? "Paddle Sandbox catalog validation failed. Checkout is disabled because the product, price, billing period, or quantity does not match the EmberBOM offer."
          : "Paddle Sandbox could not load. Checkout is temporarily unavailable; no payment was attempted."
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeSandboxCheckout, { once: true });
  } else {
    initializeSandboxCheckout();
  }
})();
