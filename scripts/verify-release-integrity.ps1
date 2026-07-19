$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$downloadsDir = Join-Path $repoRoot "downloads"
$manifestPath = Join-Path $downloadsDir "SHA256SUMS.txt"
$pages = @(
    Join-Path $repoRoot "index.html"
    Join-Path $repoRoot "fulfillment.html"
)

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "release_manifest_missing"
}

$entries = @{}
foreach ($line in Get-Content -LiteralPath $manifestPath) {
    if ([string]::IsNullOrWhiteSpace($line)) {
        continue
    }
    if ($line -notmatch '^([0-9a-f]{64})  (\S+)$') {
        throw "release_manifest_line_invalid: $line"
    }
    $entries[$Matches[2]] = $Matches[1]
}

if ($entries.Count -ne 2) {
    throw "release_manifest_expected_two_archives"
}

foreach ($entry in $entries.GetEnumerator()) {
    $archivePath = Join-Path $downloadsDir $entry.Key
    $checksumPath = "$archivePath.sha256"
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
        throw "release_archive_missing: $($entry.Key)"
    }
    if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
        throw "release_checksum_missing: $($entry.Key).sha256"
    }

    $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $entry.Value) {
        throw "release_archive_hash_mismatch: $($entry.Key)"
    }

    $individual = (Get-Content -LiteralPath $checksumPath -Raw).Trim()
    if ($individual -ne "$($entry.Value)  $($entry.Key)") {
        throw "release_individual_checksum_mismatch: $($entry.Key)"
    }
}

$releaseLinkPattern = 'href="downloads/(?<file>[^"\s]+(?:\.zip|\.tar\.gz))"[^>]*>.*?</a>\s*<code>(?<hash>[0-9a-f]{64})</code>'
foreach ($pagePath in $pages) {
    $content = Get-Content -LiteralPath $pagePath -Raw
    $matches = [regex]::Matches(
        $content,
        $releaseLinkPattern,
        [System.Text.RegularExpressions.RegexOptions]::Singleline
    )
    if ($matches.Count -ne $entries.Count) {
        throw "release_page_expected_two_archives: $([IO.Path]::GetFileName($pagePath))"
    }

    $seen = @{}
    foreach ($match in $matches) {
        $file = $match.Groups['file'].Value
        $hash = $match.Groups['hash'].Value
        if (-not $entries.ContainsKey($file)) {
            throw "release_page_unknown_archive: $file"
        }
        if ($hash -ne $entries[$file]) {
            throw "release_page_hash_mismatch: $([IO.Path]::GetFileName($pagePath)) $file"
        }
        $seen[$file] = $true
    }

    foreach ($file in $entries.Keys) {
        if (-not $seen.ContainsKey($file)) {
            throw "release_page_archive_missing: $([IO.Path]::GetFileName($pagePath)) $file"
        }
    }
}

$indexPath = Join-Path $repoRoot "index.html"
$sandboxScriptPath = Join-Path $repoRoot "paddle-sandbox.js"
$headersPath = Join-Path $repoRoot "_headers"
$index = Get-Content -LiteralPath $indexPath -Raw
$sandboxScript = Get-Content -LiteralPath $sandboxScriptPath -Raw
$headers = Get-Content -LiteralPath $headersPath -Raw
$allPublicText = Get-ChildItem -LiteralPath $repoRoot -File -Recurse |
    Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' -and $_.Extension -in @('.html', '.js', '.ps1', '.yml', '.yaml', '.txt', '.md') } |
    ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }
$allPublicText = $allPublicText -join "`n"

if ($sandboxScript -notmatch 'clientSideToken:\s*"test_[a-zA-Z0-9]{27}"') {
    throw "paddle_sandbox_client_token_missing_or_invalid"
}
if ($sandboxScript -notmatch 'priceId:\s*"pri_[a-z0-9]{26}"') {
    throw "paddle_sandbox_price_id_missing_or_invalid"
}
if ($allPublicText -match '(?i)pdl_(?:sdbx|live)_apikey_|webhook[_ -]?secret\s*[:=]') {
    throw "paddle_server_secret_detected"
}
if ($allPublicText -match 'live_[a-zA-Z0-9]{27}') {
    throw "paddle_live_client_token_detected"
}
if ($sandboxScript -notmatch 'quantity:\s*1' -or $sandboxScript -match 'quantity:\s*(?:[02-9]|[1-9][0-9]+)') {
    throw "paddle_checkout_quantity_not_fixed_to_one"
}
foreach ($productionHost in @('emberbom.com', 'www.emberbom.com', 'emberbom-site.pages.dev')) {
    if ($sandboxScript -notmatch [regex]::Escape('"' + $productionHost + '"')) {
        throw "paddle_production_host_guard_missing: $productionHost"
    }
}
$expectedPreviewHost = 'codex-t053-paddle-sandbox-fu.emberbom-site.pages.dev'
if ($sandboxScript -notmatch [regex]::Escape('"' + $expectedPreviewHost + '"')) {
    throw "paddle_exact_preview_host_missing"
}
if ($sandboxScript -match '\*\.pages\.dev' -or $sandboxScript -match 'endsWith\([^)]*pages\.dev') {
    throw "paddle_pages_preview_guard_too_broad"
}
if ($index -notmatch [regex]::Escape('One-time purchase. Taxes may apply.')) {
    throw "paddle_tax_notice_missing"
}
foreach ($requiredCheckoutField in @(
    'id="sandbox-licensee-name"',
    'maxlength="120"',
    'id="sandbox-licensee-authority"'
)) {
    if ($index -notmatch [regex]::Escape($requiredCheckoutField)) {
        throw "paddle_licensee_field_missing: $requiredCheckoutField"
    }
}
foreach ($requiredCustomData in @(
    'licensee_name: licenseeName',
    'offer_identifier: SANDBOX_CONFIG.offerIdentifier',
    'customData,'
)) {
    if ($sandboxScript -notmatch [regex]::Escape($requiredCustomData)) {
        throw "paddle_custom_data_missing: $requiredCustomData"
    }
}
if ($index -match '(?i)(billed monthly|billed annually|recurring purchase|subscription purchase)') {
    throw "paddle_offer_described_as_recurring"
}
foreach ($requiredPath in @('license.txt', 'refund.html', 'privacy.html', 'contact.html', 'quick-start.html')) {
    if ($index -notmatch [regex]::Escape($requiredPath)) {
        throw "required_public_path_missing: $requiredPath"
    }
}
foreach ($requiredCsp in @("frame-ancestors 'none'", "base-uri 'self'", "X-Content-Type-Options", "Referrer-Policy")) {
    if ($headers -notmatch [regex]::Escape($requiredCsp)) {
        throw "required_security_header_missing: $requiredCsp"
    }
}
foreach ($requiredPaddleOrigin in @(
    'https://cdn.paddle.com',
    'https://sandbox-api.paddle.com',
    'https://sandbox-cdn.paddle.com',
    'https://sandbox-buy.paddle.com'
)) {
    if ($headers -notmatch [regex]::Escape($requiredPaddleOrigin)) {
        throw "required_paddle_csp_origin_missing: $requiredPaddleOrigin"
    }
}
if ($headers -notmatch [regex]::Escape('payment=(self "https://sandbox-buy.paddle.com")')) {
    throw "paddle_payment_permission_not_minimally_scoped"
}
if ($headers -match '(?m)(?:^|;\s*)(?:script-src|connect-src|frame-src)\s+[^;]*\*' -or $headers -match "'unsafe-eval'") {
    throw "paddle_csp_is_broad_or_unsafe"
}

"PUBLIC_RELEASE_INTEGRITY=PASS"
"PADDLE_SANDBOX_INTEGRATION=PASS"
