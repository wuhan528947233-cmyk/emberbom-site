# Paddle Live disabled production acceptance (T056)

T056 deploys the reviewed Paddle environment-isolation code while keeping Live checkout disabled. It does not create a Live webhook, configure a Production webhook secret, enable real payments, or create a real transaction.

## Fixed safety state

- Production uses `PADDLE_ENVIRONMENT=live` and `PADDLE_LIVE_CHECKOUT_ENABLED=false`.
- Production binds `LICENSE_DB` only to `emberbom-licenses-production`.
- Production does not receive a Sandbox token, Product ID, Price ID, D1 binding, or webhook secret.
- Preview remains isolated to Paddle Sandbox and `emberbom-licenses-sandbox`.
- The only approved Live checkout hostname is `emberbom.com`; `www.emberbom.com` remains blocked.
- Missing configuration must fail closed. It must never fall back from Live to Sandbox.

## Before deployment

1. Record the current production Git commit and Cloudflare Pages deployment ID.
2. Run `scripts/verify-paddle-live-preflight.ps1`.
3. Run `scripts/verify-download-counter.ps1`.
4. Confirm the Production D1 is empty with read-only queries:

```sql
SELECT COUNT(*) AS entitlement_rows FROM entitlements;
SELECT COUNT(*) AS processed_event_rows FROM processed_events;
```

Both counts must be `0`. Do not insert, update, delete, migrate, or replay events during T056.

## After deployment

Run:

```powershell
./scripts/verify-paddle-live-disabled-production.ps1
```

Then repeat the two read-only D1 queries. Both counts must still be `0`.

The acceptance also requires:

- `/api/paddle-config` returns only `{"enabled":false}` on `emberbom.com`.
- `/api/paddle-webhook` returns `404` on `emberbom.com`.
- No token, Product ID, Price ID, database identifier, or secret appears in either response.
- Critical site, legal, download, checksum, privacy, and security-header checks pass.
- Preview still resolves only to Sandbox and does not contain Live identifiers.

## Rollback

If any check fails:

1. Keep `PADDLE_LIVE_CHECKOUT_ENABLED=false`; do not add a webhook or secret.
2. In Cloudflare Pages, roll production back to the production deployment recorded before T056.
3. Revert the T056 merge on `main` and push the revert so Git and Cloudflare agree.
4. Re-run the critical-page, release-integrity, download-counter, and D1 read-only checks.
5. Do not retry the production deployment until the failure has a verified cause and fix.

## Remaining go-live gates

T056 does not authorize Live payments. Before a later go-live decision:

- `support@emberbom.com` must pass branded outbound reply and delivery tests.
- The paid build must use a signed offline license that preserves EmberBOM's offline and privacy model.
- A Live Paddle webhook and Production secret require a separate approved task.
