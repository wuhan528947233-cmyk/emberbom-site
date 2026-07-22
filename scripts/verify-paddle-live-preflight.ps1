param(
    [string]$NodeExecutable = "node"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$wranglerPath = Join-Path $repoRoot "wrangler.toml"
$runtimePath = Join-Path $repoRoot "functions/_lib/paddle-runtime.mjs"
$frontendPath = Join-Path $repoRoot "paddle-sandbox.js"
$preflightTestPath = Join-Path $repoRoot "tests/paddle-live-preflight.test.mjs"

& (Join-Path $PSScriptRoot "verify-paddle-fulfillment.ps1") -NodeExecutable $NodeExecutable

& $NodeExecutable --test $preflightTestPath
if ($LASTEXITCODE -ne 0) { throw "paddle_live_preflight_tests_failed" }

$wrangler = Get-Content -LiteralPath $wranglerPath -Raw
$runtime = Get-Content -LiteralPath $runtimePath -Raw
$frontend = Get-Content -LiteralPath $frontendPath -Raw

foreach ($required in @(
    '[env.production.vars]',
    'PADDLE_ENVIRONMENT = "live"',
    'PADDLE_LIVE_CHECKOUT_ENABLED = "false"',
    'database_name = "emberbom-licenses-production"',
    '[env.preview.vars]',
    'PADDLE_ENVIRONMENT = "sandbox"',
    'database_name = "emberbom-licenses-sandbox"'
)) {
    if ($wrangler -notmatch [regex]::Escape($required)) {
        throw "paddle_live_preflight_config_missing: $required"
    }
}

if ($wrangler -match '(?i)PADDLE_(?:CLIENT_SIDE_TOKEN|PRODUCT_ID|PRICE_ID|WEBHOOK_SECRET)\s*=') {
    throw "paddle_identifier_or_secret_committed_to_wrangler"
}
if (($runtime + "`n" + $frontend) -match '(?:test|live)_[a-zA-Z0-9]{20,}' -or
    ($runtime + "`n" + $frontend) -match '(?:pri|pro)_[a-z0-9]{26}') {
    throw "paddle_catalog_value_hardcoded_in_business_code"
}

$scanText = Get-ChildItem -LiteralPath $repoRoot -File -Recurse |
    Where-Object {
        $_.FullName -notmatch '[\\/]\.git[\\/]' -and
        $_.FullName -notmatch '[\\/]tests[\\/]' -and
        $_.Name -notin @('verify-paddle-fulfillment.ps1', 'verify-paddle-live-preflight.ps1') -and
        $_.Extension -in @('.html', '.js', '.mjs', '.ps1', '.toml', '.yml', '.yaml', '.json', '.sql', '.css', '.txt', '.md')
    } |
    ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -ErrorAction Stop }
$scanText = $scanText -join "`n"
if ($scanText -match 'pdl_(?:sdbx|live)_apikey_' -or
    $scanText -match 'pdl_ntfset_' -or
    $scanText -match 'CLOUDFLARE_API_TOKEN\s*=' -or
    $scanText -match '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----') {
    throw "sensitive_information_detected"
}

& (Join-Path $PSScriptRoot "verify-release-integrity.ps1")

"PADDLE_LIVE_PREFLIGHT=PASS"
"SENSITIVE_INFORMATION_SCAN=PASS"
"PUBLIC_RELEASE_INTEGRITY=PASS"
