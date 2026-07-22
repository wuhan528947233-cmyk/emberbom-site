CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entitlements (
  transaction_id TEXT PRIMARY KEY,
  customer_id TEXT,
  product_id TEXT,
  price_id TEXT,
  licensee_name TEXT,
  offer_identifier TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'review_required')),
  granted_at TEXT,
  revoked_at TEXT,
  last_event_at TEXT NOT NULL,
  last_adjustment_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entitlements_status ON entitlements(status);
