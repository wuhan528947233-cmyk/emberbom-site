$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$downloadsDir = Join-Path $repoRoot "downloads"
$manifestPath = Join-Path $downloadsDir "SHA256SUMS.txt"
$pages = @(
    Join-Path $repoRoot "index.html"
    Join-Path $repoRoot "fulfillment.html"
)
$platformFiles = @{
    windows = "emberbom_v0.1.0-rc.9_windows_amd64.zip"
    linux = "emberbom_v0.1.0-rc.9_linux_amd64.tar.gz"
}

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

$releaseLinkPattern = 'href="/download/(?<platform>windows|linux)"[^>]*>.*?</a>\s*<code>(?<hash>[0-9a-f]{64})</code>'
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
        $platform = $match.Groups['platform'].Value
        $file = $platformFiles[$platform]
        $hash = $match.Groups['hash'].Value
        if ([string]::IsNullOrWhiteSpace($file)) {
            throw "release_page_unknown_platform: $platform"
        }
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

"PUBLIC_RELEASE_INTEGRITY=PASS"
