import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  INSERT_PROCESSED_EVENT_SQL,
  OFFER_IDENTIFIER,
  EXPECTED_PRICE_ID,
  buildEntitlementMutation,
  classifyFulfillmentEvent,
  verifyPaddleSignature,
} from "../functions/_lib/paddle-fulfillment.mjs";

const SCHEMA = readFileSync(new URL("../migrations/0001_paddle_sandbox_fulfillment.sql", import.meta.url), "utf8");
const SECRET = "sandbox-notification-secret-for-tests";
const endpointSource = readFileSync(new URL("../functions/api/paddle-webhook.js", import.meta.url), "utf8")
  .replace("../_lib/paddle-fulfillment.mjs", new URL("../functions/_lib/paddle-fulfillment.mjs", import.meta.url).href);
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(endpointSource).toString("base64")}`);
const ids = {
  event: (character) => `evt_${character.repeat(26)}`,
  transaction: (character) => `txn_${character.repeat(26)}`,
  customer: (character) => `ctm_${character.repeat(26)}`,
  product: (character) => `pro_${character.repeat(26)}`,
  adjustment: (character) => `adj_${character.repeat(26)}`,
};

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

class D1Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new D1Statement(this.db, this.sql, params);
  }

  async first() {
    return this.db.prepare(this.sql).get(...this.params) || null;
  }

  async run() {
    return this.db.prepare(this.sql).run(...this.params);
  }
}

class FakeD1 {
  constructor() {
    this.db = database();
  }

  prepare(sql) {
    return new D1Statement(this.db, sql);
  }

  async batch(statements) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function transactionEvent({
  eventCharacter = "a",
  transactionCharacter = "a",
  transactionId = ids.transaction(transactionCharacter),
  occurredAt = "2026-07-19T10:00:00.000Z",
  licenseeName = "Example Robotics Ltd",
} = {}) {
  return {
    event_id: ids.event(eventCharacter),
    event_type: "transaction.completed",
    occurred_at: occurredAt,
    data: {
      id: transactionId,
      status: "completed",
      customer_id: ids.customer(transactionCharacter),
      collection_mode: "automatic",
      origin: "web",
      subscription_id: null,
      custom_data: {
        licensee_name: licenseeName,
        offer_identifier: OFFER_IDENTIFIER,
      },
      items: [
        {
          quantity: 1,
          price: {
            id: EXPECTED_PRICE_ID,
            product_id: ids.product(transactionCharacter),
            billing_cycle: null,
          },
        },
      ],
    },
  };
}

function adjustmentEvent({
  eventCharacter,
  transactionCharacter = "a",
  adjustmentCharacter,
  occurredAt,
  action = "refund",
  status = "approved",
  type = "full",
  itemType = "full",
  total = "10779",
  itemTotal = total,
  amount = total,
  items,
  eventType = "adjustment.updated",
}) {
  return {
    event_id: ids.event(eventCharacter),
    event_type: eventType,
    occurred_at: occurredAt,
    data: {
      id: ids.adjustment(adjustmentCharacter),
      transaction_id: ids.transaction(transactionCharacter),
      action,
      status,
      type,
      totals: { total },
      items: items === undefined ? [
        {
          type: itemType,
          amount,
          totals: { total: itemTotal },
        },
      ] : items,
    },
  };
}

function apply(db, event, processedAt = "2026-07-19T12:00:00.000Z") {
  const decision = classifyFulfillmentEvent(event);
  const duplicate = db.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").get(decision.eventId);
  if (duplicate) {
    return "duplicate";
  }
  const mutation = buildEntitlementMutation(decision, processedAt);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (mutation) {
      db.prepare(mutation.sql).run(...mutation.params);
    }
    db.prepare(INSERT_PROCESSED_EVENT_SQL).run(
      decision.eventId,
      decision.eventType,
      decision.occurredAt,
      processedAt
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return "processed";
}

async function signature(rawBody, timestamp) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}:${rawBody}`));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedRequest(event, host = "codex-t053-paddle-sandbox-fu.emberbom-site.pages.dev") {
  const rawBody = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const h1 = await signature(rawBody, timestamp);
  return new Request(`https://${host}/api/paddle-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Paddle-Signature": `ts=${timestamp};h1=${h1}`,
    },
    body: rawBody,
  });
}

test("accepts a current valid signature and rejects missing, wrong, and expired signatures", async () => {
  const now = Date.UTC(2026, 6, 19, 10, 0, 0);
  const timestamp = String(now / 1000);
  const rawBody = '{"event_id":"evt_test"}';
  const valid = await signature(rawBody, timestamp);
  assert.equal(await verifyPaddleSignature(rawBody, `ts=${timestamp};h1=${valid}`, SECRET, now), true);
  assert.equal(await verifyPaddleSignature(rawBody, null, SECRET, now), false);
  assert.equal(await verifyPaddleSignature(rawBody, `ts=${timestamp};h1=${"0".repeat(64)}`, SECRET, now), false);
  assert.equal(await verifyPaddleSignature(rawBody, `ts=${Number(timestamp) - 6};h1=${valid}`, SECRET, now), false);
});

test("Pages endpoint rejects unsigned requests without writing to D1", async () => {
  const d1 = new FakeD1();
  const response = await onRequest({
    request: new Request("https://codex-t053-paddle-sandbox-fu.emberbom-site.pages.dev/api/paddle-webhook", {
      method: "POST",
      body: JSON.stringify(transactionEvent()),
    }),
    env: { PADDLE_WEBHOOK_SECRET: SECRET, LICENSE_DB: d1 },
  });
  assert.equal(response.status, 401);
  assert.equal(d1.db.prepare("SELECT COUNT(*) AS count FROM processed_events").get().count, 0);
  assert.equal(d1.db.prepare("SELECT COUNT(*) AS count FROM entitlements").get().count, 0);
});

test("Pages endpoint reports configuration failure without configuration probes", async () => {
  const previewUrl = "https://codex-t053-paddle-sandbox-fu.emberbom-site.pages.dev/api/paddle-webhook";
  const request = (hostname = previewUrl) => new Request(hostname, { method: "POST", body: "{}" });

  let response = await onRequest({ request: request(), env: {} });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "sandbox_fulfillment_not_configured",
  });

  response = await onRequest({
    request: request(),
    env: { PADDLE_WEBHOOK_SECRET: SECRET, LICENSE_DB: {} },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "sandbox_fulfillment_not_configured",
  });

  response = await onRequest({
    request: request(),
    env: { LICENSE_DB: new FakeD1() },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "sandbox_fulfillment_not_configured",
  });

  response = await onRequest({
    request: request("https://emberbom.com/api/paddle-webhook"),
    env: {},
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: "not_found" });
});

test("Pages endpoint accepts a signed event once and rejects production hosts", async () => {
  const d1 = new FakeD1();
  const event = transactionEvent();
  let response = await onRequest({
    request: await signedRequest(event),
    env: { PADDLE_WEBHOOK_SECRET: SECRET, LICENSE_DB: d1 },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result, "processed");
  assert.equal(d1.db.prepare("SELECT status FROM entitlements").get().status, "active");

  response = await onRequest({
    request: await signedRequest(event),
    env: { PADDLE_WEBHOOK_SECRET: SECRET, LICENSE_DB: d1 },
  });
  assert.equal((await response.json()).result, "duplicate");

  const productionDb = new FakeD1();
  response = await onRequest({
    request: await signedRequest(event, "emberbom.com"),
    env: { PADDLE_WEBHOOK_SECRET: SECRET, LICENSE_DB: productionDb },
  });
  assert.equal(response.status, 404);
  assert.equal(productionDb.db.prepare("SELECT COUNT(*) AS count FROM processed_events").get().count, 0);
});

test("Pages endpoint returns 405 for GET without exposing business data", async () => {
  const response = await onRequest({
    request: new Request("https://codex-t053-paddle-sandbox-fu.emberbom-site.pages.dev/api/paddle-webhook"),
    env: {},
  });
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { ok: false, error: "method_not_allowed" });
});

test("grants one active entitlement only for the exact one-time offer", () => {
  const db = database();
  const event = transactionEvent();
  assert.equal(apply(db, event), "processed");
  assert.equal(apply(db, event), "duplicate");
  const row = db.prepare("SELECT * FROM entitlements").get();
  assert.equal(row.status, "active");
  assert.equal(row.licensee_name, "Example Robotics Ltd");
  assert.equal(row.price_id, EXPECTED_PRICE_ID);
  assert.equal(row.offer_identifier, OFFER_IDENTIFIER);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM processed_events").get().count, 1);
});

test("missing licensee metadata is review_required rather than active", () => {
  const db = database();
  apply(db, transactionEvent({ licenseeName: "" }));
  const row = db.prepare("SELECT status, licensee_name FROM entitlements").get();
  assert.equal(row.status, "review_required");
  assert.equal(row.licensee_name, null);
});

test("catalog, quantity, offer, collection, and subscription mismatches never grant active", () => {
  const mutations = [
    (event) => { event.data.items[0].price.id = `pri_${"z".repeat(26)}`; },
    (event) => { event.data.items[0].quantity = 2; },
    (event) => { event.data.custom_data.offer_identifier = "wrong_offer"; },
    (event) => { event.data.collection_mode = "manual"; },
    (event) => { event.data.subscription_id = `sub_${"s".repeat(26)}`; },
    (event) => { event.data.items[0].price.billing_cycle = { interval: "month", frequency: 1 }; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const db = database();
    const event = transactionEvent({
      eventCharacter: String.fromCharCode(103 + index),
      transactionCharacter: String.fromCharCode(103 + index),
    });
    mutate(event);
    apply(db, event);
    assert.equal(db.prepare("SELECT status FROM entitlements").get().status, "review_required");
  }
});

test("an approved full refund revokes and an older completed event cannot reactivate", () => {
  const db = database();
  apply(db, transactionEvent({ occurredAt: "2026-07-19T10:00:00.000Z" }));
  apply(db, adjustmentEvent({
    eventCharacter: "b",
    adjustmentCharacter: "b",
    occurredAt: "2026-07-19T10:30:00.000Z",
  }));
  let row = db.prepare("SELECT status, revoked_at, last_adjustment_id FROM entitlements").get();
  assert.equal(row.status, "revoked");
  assert.equal(row.revoked_at, "2026-07-19T10:30:00.000Z");
  assert.equal(row.last_adjustment_id, ids.adjustment("b"));

  apply(db, transactionEvent({
    eventCharacter: "c",
    occurredAt: "2026-07-19T10:15:00.000Z",
  }));
  row = db.prepare("SELECT status, last_event_at FROM entitlements").get();
  assert.equal(row.status, "revoked");
  assert.equal(row.last_event_at, "2026-07-19T10:30:00.000Z");
});

test("real Paddle single-item full refund revokes when top-level type is partial", () => {
  const db = database();
  const transactionId = "txn_01kxwn0jbkx2snhykxrwk8ftr2";
  const adjustment = {
    event_id: "evt_01kxwp79hkecv33j5g42vkr492",
    event_type: "adjustment.updated",
    occurred_at: "2026-07-19T07:52:00.000Z",
    data: {
      id: "adj_01kxwnsn9g10rpw81qswcyssh8",
      transaction_id: transactionId,
      action: "refund",
      status: "approved",
      type: "partial",
      totals: { total: "10779" },
      items: [
        {
          type: "full",
          amount: "10779",
          totals: { total: "10779" },
        },
      ],
    },
  };

  apply(db, transactionEvent({
    transactionId,
    occurredAt: "2026-07-19T07:00:00.000Z",
  }));
  assert.equal(classifyFulfillmentEvent(adjustment).kind, "revoke");
  apply(db, adjustment);
  const row = db.prepare("SELECT status, last_adjustment_id FROM entitlements").get();
  assert.equal(row.status, "revoked");
  assert.equal(row.last_adjustment_id, adjustment.data.id);
});

for (const scenario of [
  { name: "partial item refund", type: "partial", itemType: "partial" },
  {
    name: "multiple items with only one full item",
    type: "partial",
    items: [
      { type: "full", amount: "10779", totals: { total: "10779" } },
      { type: "partial", amount: "1", totals: { total: "1" } },
    ],
  },
  { name: "item total mismatch", type: "partial", itemTotal: "10778" },
  { name: "item amount mismatch", type: "partial", amount: "10778" },
  { name: "zero adjustment total", type: "full", total: "0" },
  { name: "non-integer adjustment total", type: "full", total: "107.79" },
  { name: "numeric adjustment total", type: "full", total: 10779 },
  { name: "created refund event", type: "full", eventType: "adjustment.created" },
  { name: "pending refund", type: "full", status: "pending_approval" },
  { name: "rejected refund", type: "full", status: "rejected" },
  { name: "missing items", type: "partial", items: null },
  { name: "malformed items", type: "partial", items: {} },
]) {
  test(`${scenario.name} does not revoke`, () => {
    const db = database();
    apply(db, transactionEvent());
    apply(db, adjustmentEvent({
      eventCharacter: "d",
      adjustmentCharacter: "d",
      occurredAt: "2026-07-19T11:00:00.000Z",
      type: scenario.type,
      status: scenario.status,
      itemType: scenario.itemType,
      total: scenario.total,
      itemTotal: scenario.itemTotal,
      amount: scenario.amount,
      items: scenario.items,
      eventType: scenario.eventType,
    }));
    assert.equal(db.prepare("SELECT status FROM entitlements").get().status, "active");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM processed_events").get().count, 2);
  });
}

test("a duplicate full-refund event is idempotent", () => {
  const db = database();
  const event = adjustmentEvent({
    eventCharacter: "q",
    adjustmentCharacter: "q",
    occurredAt: "2026-07-19T11:00:00.000Z",
  });
  apply(db, transactionEvent());
  assert.equal(apply(db, event), "processed");
  const first = db.prepare("SELECT status, updated_at FROM entitlements").get();
  assert.equal(apply(db, event, "2026-07-19T12:30:00.000Z"), "duplicate");
  const second = db.prepare("SELECT status, updated_at FROM entitlements").get();
  assert.deepEqual(second, first);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM processed_events WHERE event_id = ?").get(event.event_id).count, 1);
});

test("a full-refund event without a matching entitlement cannot create a revoked entitlement", () => {
  const db = database();
  const event = adjustmentEvent({
    eventCharacter: "r",
    transactionCharacter: "r",
    adjustmentCharacter: "r",
    occurredAt: "2026-07-19T11:00:00.000Z",
  });
  assert.equal(apply(db, event), "processed");
  assert.equal(db.prepare("SELECT status FROM entitlements").get().status, "review_required");
});

test("chargeback reverse requires review and never restores active automatically", () => {
  const db = database();
  apply(db, transactionEvent());
  apply(db, adjustmentEvent({
    eventCharacter: "e",
    adjustmentCharacter: "e",
    occurredAt: "2026-07-19T11:00:00.000Z",
    action: "chargeback",
  }));
  apply(db, adjustmentEvent({
    eventCharacter: "f",
    adjustmentCharacter: "f",
    occurredAt: "2026-07-19T11:30:00.000Z",
    action: "chargeback_reverse",
  }));
  assert.equal(db.prepare("SELECT status FROM entitlements").get().status, "review_required");
});

test("schema stores no raw payment, request, or project fields", () => {
  for (const forbidden of ["card_number", "cvv", "billing_address", "raw_body", "request_headers", "project_source"]) {
    assert.equal(SCHEMA.includes(forbidden), false);
  }
});
