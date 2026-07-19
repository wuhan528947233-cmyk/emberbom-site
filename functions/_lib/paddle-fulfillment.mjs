export const EXPECTED_PRICE_ID = "pri_01kxw46v5y5m181arczqex1gw8";
export const OFFER_IDENTIFIER = "emberbom_founding_team_v1";
export const SIGNATURE_TOLERANCE_SECONDS = 5;

const EVENT_ID = /^evt_[a-z\d]{26}$/;
const TRANSACTION_ID = /^txn_[a-z\d]{26}$/;
const CUSTOMER_ID = /^ctm_[a-z\d]{26}$/;
const PRODUCT_ID = /^pro_[a-z\d]{26}$/;
const ADJUSTMENT_ID = /^adj_[a-z\d]{26}$/;

function validId(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

export function normalizeLicenseeName(value) {
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

export function normalizeOccurredAt(value) {
  if (typeof value !== "string") {
    throw new Error("event_occurred_at_invalid");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("event_occurred_at_invalid");
  }
  return new Date(timestamp).toISOString();
}

function parseSignatureHeader(header) {
  if (typeof header !== "string" || header.length > 2048) {
    return null;
  }
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "ts" && /^\d{1,12}$/.test(value)) {
      timestamp = value;
    } else if (key === "h1" && /^[a-f\d]{64}$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  return timestamp && signatures.length ? { timestamp, signatures } : null;
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeHexEqual(left, right) {
  if (!/^[a-f\d]{64}$/.test(left) || !/^[a-f\d]{64}$/.test(right)) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function verifyPaddleSignature(rawBody, header, secret, nowMs = Date.now()) {
  const parsed = parseSignatureHeader(header);
  if (!parsed || typeof rawBody !== "string" || typeof secret !== "string" || secret.length < 8) {
    return false;
  }

  const signatureTime = Number(parsed.timestamp) * 1000;
  if (
    !Number.isSafeInteger(signatureTime) ||
    Math.abs(nowMs - signatureTime) > SIGNATURE_TOLERANCE_SECONDS * 1000
  ) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = hex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${parsed.timestamp}:${rawBody}`))
  );
  return parsed.signatures.some((candidate) => timingSafeHexEqual(expected, candidate));
}

function envelope(event) {
  if (!event || typeof event !== "object" || !validId(event.event_id, EVENT_ID)) {
    throw new Error("event_id_invalid");
  }
  if (typeof event.event_type !== "string" || event.event_type.length > 80) {
    throw new Error("event_type_invalid");
  }
  return {
    eventId: event.event_id,
    eventType: event.event_type,
    occurredAt: normalizeOccurredAt(event.occurred_at),
  };
}

function classifyTransaction(event, base) {
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const items = Array.isArray(data.items) ? data.items : [];
  const item = items.length === 1 && items[0] && typeof items[0] === "object" ? items[0] : {};
  const price = item.price && typeof item.price === "object" ? item.price : {};
  const customData = data.custom_data && typeof data.custom_data === "object" ? data.custom_data : {};
  const licenseeName = normalizeLicenseeName(customData.licensee_name);
  const offerIdentifier = customData.offer_identifier === OFFER_IDENTIFIER ? OFFER_IDENTIFIER : null;
  const transactionId = validId(data.id, TRANSACTION_ID) ? data.id : null;
  const customerId = validId(data.customer_id, CUSTOMER_ID) ? data.customer_id : null;
  const productId = validId(price.product_id, PRODUCT_ID) ? price.product_id : null;
  const priceId = typeof price.id === "string" ? price.id : null;
  const valid =
    transactionId !== null &&
    customerId !== null &&
    productId !== null &&
    data.status === "completed" &&
    data.collection_mode === "automatic" &&
    data.origin === "web" &&
    data.subscription_id === null &&
    items.length === 1 &&
    item.quantity === 1 &&
    priceId === EXPECTED_PRICE_ID &&
    price.billing_cycle === null &&
    licenseeName !== null &&
    offerIdentifier === OFFER_IDENTIFIER;

  if (!transactionId) {
    return { ...base, kind: "record_only", reason: "transaction_id_invalid" };
  }

  return {
    ...base,
    kind: valid ? "grant" : "review",
    transactionId,
    customerId,
    productId,
    priceId,
    licenseeName,
    offerIdentifier,
  };
}

function classifyAdjustment(event, base) {
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const transactionId = validId(data.transaction_id, TRANSACTION_ID) ? data.transaction_id : null;
  const adjustmentId = validId(data.id, ADJUSTMENT_ID) ? data.id : null;
  if (!transactionId || !adjustmentId) {
    return { ...base, kind: "record_only", reason: "adjustment_identity_invalid" };
  }

  const common = { ...base, transactionId, adjustmentId };
  if (data.action === "refund") {
    const items = data.items;
    const item = Array.isArray(items) && items.length === 1 ? items[0] : null;
    const total = data.totals?.total;
    const isPositiveIntegerAmount = typeof total === "string" && /^[1-9]\d*$/.test(total);
    const isSingleItemFullRefund =
      base.eventType === "adjustment.updated" &&
      data.status === "approved" &&
      item &&
      typeof item === "object" &&
      item.type === "full" &&
      isPositiveIntegerAmount &&
      item.totals?.total === total &&
      (item.amount === undefined || item.amount === total);
    return { ...common, kind: isSingleItemFullRefund ? "revoke" : "record_only" };
  }
  if (data.status === "approved" && data.type === "full" && data.action === "chargeback") {
    return { ...common, kind: "revoke" };
  }
  if (data.status === "approved" && data.action === "chargeback_reverse") {
    return { ...common, kind: "review_adjustment" };
  }
  if (
    data.type === "partial" ||
    data.status === "pending_approval" ||
    data.status === "rejected"
  ) {
    return { ...common, kind: "record_only" };
  }
  return { ...common, kind: "review_adjustment" };
}

export function classifyFulfillmentEvent(event) {
  const base = envelope(event);
  if (base.eventType === "transaction.completed") {
    return classifyTransaction(event, base);
  }
  if (base.eventType === "adjustment.created" || base.eventType === "adjustment.updated") {
    return classifyAdjustment(event, base);
  }
  return { ...base, kind: "record_only" };
}

export const INSERT_PROCESSED_EVENT_SQL = `
INSERT INTO processed_events (event_id, event_type, occurred_at, processed_at)
VALUES (?, ?, ?, ?)
`;

const COMPLETED_MUTATION_SQL = `
INSERT INTO entitlements (
  transaction_id, customer_id, product_id, price_id, licensee_name, offer_identifier,
  status, granted_at, revoked_at, last_event_at, last_adjustment_id, updated_at
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?
WHERE NOT EXISTS (SELECT 1 FROM processed_events WHERE event_id = ?)
ON CONFLICT(transaction_id) DO UPDATE SET
  customer_id = excluded.customer_id,
  product_id = excluded.product_id,
  price_id = excluded.price_id,
  licensee_name = excluded.licensee_name,
  offer_identifier = excluded.offer_identifier,
  status = excluded.status,
  granted_at = CASE
    WHEN excluded.status = 'active' THEN COALESCE(entitlements.granted_at, excluded.granted_at)
    ELSE entitlements.granted_at
  END,
  last_event_at = excluded.last_event_at,
  updated_at = excluded.updated_at
WHERE excluded.last_event_at > entitlements.last_event_at
  AND entitlements.status <> 'revoked'
`;

const REVOKE_MUTATION_SQL = `
INSERT INTO entitlements (
  transaction_id, customer_id, product_id, price_id, licensee_name, offer_identifier,
  status, granted_at, revoked_at, last_event_at, last_adjustment_id, updated_at
)
SELECT ?, NULL, NULL, NULL, NULL, NULL, 'review_required', NULL, NULL, ?, ?, ?
WHERE NOT EXISTS (SELECT 1 FROM processed_events WHERE event_id = ?)
ON CONFLICT(transaction_id) DO UPDATE SET
  status = 'revoked',
  revoked_at = excluded.last_event_at,
  last_event_at = excluded.last_event_at,
  last_adjustment_id = excluded.last_adjustment_id,
  updated_at = excluded.updated_at
WHERE excluded.last_event_at > entitlements.last_event_at
`;

const REVIEW_ADJUSTMENT_MUTATION_SQL = `
INSERT INTO entitlements (
  transaction_id, customer_id, product_id, price_id, licensee_name, offer_identifier,
  status, granted_at, revoked_at, last_event_at, last_adjustment_id, updated_at
)
SELECT ?, NULL, NULL, NULL, NULL, NULL, 'review_required', NULL, NULL, ?, ?, ?
WHERE NOT EXISTS (SELECT 1 FROM processed_events WHERE event_id = ?)
ON CONFLICT(transaction_id) DO UPDATE SET
  status = 'review_required',
  last_event_at = excluded.last_event_at,
  last_adjustment_id = excluded.last_adjustment_id,
  updated_at = excluded.updated_at
WHERE excluded.last_event_at > entitlements.last_event_at
`;

export function buildEntitlementMutation(decision, processedAt) {
  if (decision.kind === "grant" || decision.kind === "review") {
    const status = decision.kind === "grant" ? "active" : "review_required";
    return {
      sql: COMPLETED_MUTATION_SQL,
      params: [
        decision.transactionId,
        decision.customerId,
        decision.productId,
        decision.priceId,
        decision.licenseeName,
        decision.offerIdentifier,
        status,
        status === "active" ? decision.occurredAt : null,
        decision.occurredAt,
        processedAt,
        decision.eventId,
      ],
    };
  }
  if (decision.kind === "revoke") {
    return {
      sql: REVOKE_MUTATION_SQL,
      params: [
        decision.transactionId,
        decision.occurredAt,
        decision.adjustmentId,
        processedAt,
        decision.eventId,
      ],
    };
  }
  if (decision.kind === "review_adjustment") {
    return {
      sql: REVIEW_ADJUSTMENT_MUTATION_SQL,
      params: [
        decision.transactionId,
        decision.occurredAt,
        decision.adjustmentId,
        processedAt,
        decision.eventId,
      ],
    };
  }
  return null;
}
