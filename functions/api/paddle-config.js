import { resolvePaddleRuntime } from "../_lib/paddle-runtime.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "GET") {
    return json(405, { enabled: false, error: "method_not_allowed" });
  }

  const runtime = resolvePaddleRuntime(new URL(request.url).hostname, env);
  if (runtime.status === "not_found") {
    return json(404, { enabled: false, error: "not_found" });
  }
  if (runtime.status === "disabled") {
    return json(200, { enabled: false });
  }
  if (runtime.status !== "ready") {
    return json(503, { enabled: false, error: "checkout_not_configured" });
  }

  return json(200, {
    enabled: true,
    environment: runtime.environment,
    clientSideToken: runtime.clientSideToken,
    productId: runtime.productId,
    priceId: runtime.priceId,
    offerIdentifier: runtime.offerIdentifier,
  });
}
