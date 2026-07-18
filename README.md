# EmberBOM website

Static English website for `emberbom.com`.

## Deployment target

- Source: dedicated public GitHub repository `emberbom-site`
- Hosting: Cloudflare Pages
- Build command: none
- Build output directory: `/`
- Production domain: `emberbom.com`

The directory is already the deployable output. Cloudflare Pages should use no
build command and `/` as the output directory.

## Before live sales

1. Deploy this directory to Cloudflare Pages and attach `emberbom.com` and
   `www.emberbom.com`.
2. Add the public support telephone required for Paddle domain review.
3. Configure authenticated outbound mail for `support@emberbom.com` before
   contacting real users. Inbound routing to Gmail was tested on 18 July 2026.
4. Replace the founding-license interest link with Paddle.js checkout using the
   live client-side token and USD 99 one-time price ID.
5. Confirm the final terms, privacy, refund, and license text.
6. Validate every download and checksum link against the current release.

## Included public evidence

- `assets/rc9-fixture-report.png`: viewport capture of the real RC9 fixture report.
- `samples/scan-report.html`: complete fixture-generated report.
- `samples/scan-result.json`: structured RC9 fixture result.
- `samples/bom.cdx.json`: CycloneDX 1.6 fixture export.
- `samples/SHA256SUMS.txt`: accepted hashes for all three outputs.
