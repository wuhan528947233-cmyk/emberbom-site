# Paddle Live preflight (T055)

Status: code and configuration preparation only. Live checkout is disabled, no Live webhook destination exists, and no production deployment or real transaction is authorized by this task.

## Environment isolation

| Setting | Preview | Production |
|---|---|---|
| Paddle environment | `sandbox` | `live` |
| Approved checkout host | branch Preview host or localhost | `emberbom.com` only |
| Client-side token | Sandbox token (`test_...`) | Live token (`live_...`) |
| Product and price | Sandbox catalog identifiers | Live catalog identifiers |
| D1 binding | `emberbom-licenses-sandbox` | `emberbom-licenses-production` |
| Live checkout switch | `false` | `false` until separately approved |

The browser obtains public checkout identifiers from `/api/paddle-config`. It does not contain hardcoded Paddle identifiers and does not fall back between environments. The webhook independently validates the environment, exact host, Product ID, Price ID, fixed `emberbom_founding_team_v1` offer, Paddle signature, idempotency, and entitlement state transitions.

## Cloudflare environment configuration

The Pages Wrangler file is the source of truth. T056 keeps the browser-safe Sandbox client token, Product ID, and Price ID only in `env.preview.vars`; they must never be copied to Production. The Sandbox webhook secret remains encrypted outside Git.

Preview:

- `PADDLE_ENVIRONMENT=sandbox`
- `PADDLE_CLIENT_SIDE_TOKEN`, `PADDLE_PRODUCT_ID`, and `PADDLE_PRICE_ID` are the reviewed Sandbox public identifiers in `env.preview.vars`
- `PADDLE_WEBHOOK_SECRET=<existing Sandbox notification destination secret>`
- `PADDLE_LIVE_CHECKOUT_ENABLED=false`
- `LICENSE_DB` remains bound to `emberbom-licenses-sandbox`
- `DOWNLOAD_METRICS_DB` remains bound to `emberbom-download-metrics-preview`

Production, only after a separate approval:

- `PADDLE_ENVIRONMENT=live`
- `PADDLE_CLIENT_SIDE_TOKEN=<Live client-side token>`
- `PADDLE_PRODUCT_ID=<Live Product ID>`
- `PADDLE_PRICE_ID=<Live Price ID>`
- `PADDLE_LIVE_CHECKOUT_ENABLED=false` until the final go-live action
- `LICENSE_DB` remains bound to `emberbom-licenses-production`
- `DOWNLOAD_METRICS_DB` remains bound to `emberbom-download-metrics`

Do not add a Production `PADDLE_WEBHOOK_SECRET` until a Live notification destination is deliberately created in a later approved task. Do not use a Paddle API key.

## Live webhook checklist for a later task

1. Confirm `emberbom.com` remains Paddle-approved. Do not use `www.emberbom.com` until Paddle approves it.
2. Create one Live notification destination for `https://emberbom.com/api/paddle-webhook`.
3. Subscribe only to `transaction.completed`, `adjustment.created`, and `adjustment.updated`.
4. Store the generated endpoint secret only as the Production Cloudflare secret `PADDLE_WEBHOOK_SECRET`.
5. Confirm the Production Product ID, Price ID, and fixed offer identifier are the configured whitelist.
6. Verify unsigned and incorrectly signed requests fail, duplicates remain idempotent, full approved refunds revoke, partial or pending refunds do not revoke, and revoked entitlements cannot reactivate.
7. Keep `PADDLE_LIVE_CHECKOUT_ENABLED=false` until every check is complete and a separate human approval authorizes the final switch.

## Stop condition

T055 stops after code, local tests, CI, and sensitive-information checks. It does not create a Live webhook, deploy Production, enable Live checkout, or create a real transaction.
