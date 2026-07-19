import {
  INSERT_PROCESSED_EVENT_SQL,
  buildEntitlementMutation,
  classifyFulfillmentEvent,
  verifyPaddleSignature,
} from "../_lib/paddle-fulfillment.mjs";

const ALLOWED_SANDBOX_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "codex-t053-paddle-sandbox-fu.emberbom-site.pages.dev",
]);
const MAX_BODY_BYTES = 262144;

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

async function eventAlreadyProcessed(database, eventId) {
  return Boolean(
    await database
      .prepare("SELECT event_id FROM processed_events WHERE event_id = ? LIMIT 1")
      .bind(eventId)
      .first()
  );
}

async function persistEvent(database, decision, processedAt) {
  if (await eventAlreadyProcessed(database, decision.eventId)) {
    return "duplicate";
  }

  const processedStatement = database
    .prepare(INSERT_PROCESSED_EVENT_SQL)
    .bind(decision.eventId, decision.eventType, decision.occurredAt, processedAt);
  const mutation = buildEntitlementMutation(decision, processedAt);

  try {
    if (mutation) {
      await database.batch([
        database.prepare(mutation.sql).bind(...mutation.params),
        processedStatement,
      ]);
    } else {
      await processedStatement.run();
    }
  } catch (error) {
    if (await eventAlreadyProcessed(database, decision.eventId)) {
      return "duplicate";
    }
    throw error;
  }
  return "processed";
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "method_not_allowed" });
  }

  const hostname = new URL(request.url).hostname.toLowerCase();
  if (!ALLOWED_SANDBOX_HOSTS.has(hostname)) {
    return json(404, { ok: false, error: "not_found" });
  }
  if (!env.PADDLE_WEBHOOK_SECRET || !env.LICENSE_DB) {
    return json(503, { ok: false, error: "sandbox_fulfillment_not_configured" });
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: "payload_too_large" });
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: "payload_too_large" });
  }

  const signatureValid = await verifyPaddleSignature(
    rawBody,
    request.headers.get("Paddle-Signature"),
    env.PADDLE_WEBHOOK_SECRET
  );
  if (!signatureValid) {
    return json(401, { ok: false, error: "invalid_signature" });
  }

  let decision;
  try {
    decision = classifyFulfillmentEvent(JSON.parse(rawBody));
  } catch {
    return json(400, { ok: false, error: "invalid_event" });
  }

  try {
    const result = await persistEvent(env.LICENSE_DB, decision, new Date().toISOString());
    return json(200, { ok: true, result });
  } catch {
    return json(500, { ok: false, error: "processing_failed" });
  }
}
