param(
    [string]$NodeExecutable = "node"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$functionPath = Join-Path $repoRoot "functions/api/paddle-webhook.js"
$corePath = Join-Path $repoRoot "functions/_lib/paddle-fulfillment.mjs"
$schemaPath = Join-Path $repoRoot "migrations/0001_paddle_sandbox_fulfillment.sql"
$routesPath = Join-Path $repoRoot "_routes.json"
$indexPath = Join-Path $repoRoot "index.html"
$sandboxPath = Join-Path $repoRoot "paddle-sandbox.js"
$testPath = Join-Path $repoRoot "tests/paddle-fulfillment.test.mjs"

foreach ($path in @($functionPath, $corePath, $schemaPath, $routesPath, $testPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "paddle_fulfillment_file_missing: $path"
    }
}

$function = Get-Content -LiteralPath $functionPath -Raw
$core = Get-Content -LiteralPath $corePath -Raw
$schema = Get-Content -LiteralPath $schemaPath -Raw
$routes = Get-Content -LiteralPath $routesPath -Raw
$index = Get-Content -LiteralPath $indexPath -Raw
$sandbox = Get-Content -LiteralPath $sandboxPath -Raw
$allText = Get-ChildItem -LiteralPath $repoRoot -File -Recurse |
    Where-Object {
        $_.FullName -notmatch '[\\/]\.git[\\/]' -and
        $_.Extension -in @('.html', '.js', '.mjs', '.ps1', '.yml', '.yaml', '.json', '.sql', '.css', '.txt', '.md')
    } |
    ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -ErrorAction SilentlyContinue }
$allText = $allText -join "`n"

if ($allText -match '(?i)pdl_(?:sdbx|live)_apikey_[a-z0-9]+' -or
    $allText -match '(?i)pdl_ntfset_[a-z0-9]+' -or
    $allText -match 'live_[a-zA-Z0-9]{27}') {
    throw "paddle_server_or_live_secret_detected"
}
foreach ($requiredBinding in @('PADDLE_WEBHOOK_SECRET', 'LICENSE_DB')) {
    if ($function -notmatch [regex]::Escape($requiredBinding)) {
        throw "paddle_fulfillment_binding_missing: $requiredBinding"
    }
}
foreach ($requiredSecurity in @(
    'request.text()',
    'Paddle-Signature',
    'verifyPaddleSignature',
    'SIGNATURE_TOLERANCE_SECONDS = 5',
    'crypto.subtle.sign("HMAC"',
    'timingSafeHexEqual'
)) {
    if (($function + "`n" + $core) -notmatch [regex]::Escape($requiredSecurity)) {
        throw "paddle_fulfillment_security_rule_missing: $requiredSecurity"
    }
}
if ($function -notmatch 'request\.method\s*!==\s*"POST"' -or $function -notmatch 'json\(405') {
    throw "paddle_fulfillment_post_only_missing"
}
$previewHost = 'codex-t053-paddle-sandbox-fu.emberbom-site.pages.dev'
if ($function -notmatch [regex]::Escape('"' + $previewHost + '"')) {
    throw "paddle_fulfillment_preview_host_missing"
}
foreach ($productionHost in @('emberbom.com', 'www.emberbom.com', 'emberbom-site.pages.dev')) {
    if ($function -match [regex]::Escape('"' + $productionHost + '"')) {
        throw "paddle_fulfillment_production_host_enabled: $productionHost"
    }
}
if ($routes -notmatch [regex]::Escape('"include": ["/api/paddle-webhook"]')) {
    throw "paddle_fulfillment_route_not_isolated"
}
foreach ($table in @('processed_events', 'entitlements')) {
    if ($schema -notmatch [regex]::Escape("CREATE TABLE IF NOT EXISTS $table")) {
        throw "paddle_fulfillment_table_missing: $table"
    }
}
foreach ($forbiddenColumn in @('card_number', 'cvv', 'billing_address', 'raw_body', 'request_headers', 'project_source')) {
    if ($schema -match "(?im)^\s*$([regex]::Escape($forbiddenColumn))\s+") {
        throw "paddle_fulfillment_forbidden_column: $forbiddenColumn"
    }
}
foreach ($requiredFrontend in @(
    'Legal organization name',
    'authorized to purchase for this legal organization',
    'licensee_name: licenseeName',
    'offer_identifier: SANDBOX_CONFIG.offerIdentifier',
    'customData,'
)) {
    if (($index + "`n" + $sandbox) -notmatch [regex]::Escape($requiredFrontend)) {
        throw "paddle_fulfillment_frontend_rule_missing: $requiredFrontend"
    }
}
if (($function + "`n" + $core) -match 'console\.(?:log|debug|info)') {
    throw "paddle_fulfillment_customer_logging_detected"
}
if (($function + "`n" + $core) -match 'subscription\.(?:created|updated|canceled)') {
    throw "paddle_subscription_event_detected"
}

& $NodeExecutable --test $testPath
if ($LASTEXITCODE -ne 0) {
    throw "paddle_fulfillment_tests_failed"
}

"PADDLE_SANDBOX_FULFILLMENT=PASS"
